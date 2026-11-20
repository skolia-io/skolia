// The lexicon's public API, under /v1: entries by id or spelling, and each language's
// lexicon's version and credits. Anyone can read it, from any origin. Every response says
// its licence (LICENSE_LINK, and each entry's license and attribution). A response is
// the version's it was made from, and versions don't change, so each is cached at the edge
// under the versions it read and sent with them as its ETag.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { langOf, type FeatureSets, type Lang, type LemmaId, type LexiconEntry } from "@skolia/shared/api";
import * as schemas from "@skolia/shared/schemas";
import { badRequest, describe, json, responses, scalarPage, validator } from "@skolia/util/openapi";
import { log } from "@skolia/util/log";
import { LICENSE, LICENSE_LINK, attribution, sources, wiktionaryUrl } from "./licence.ts";
import type { Found, Incoming, Lexicon, ResponseCache } from "./ports.ts";
import * as api from "./schemas.ts";
import spec from "../openapi.json" with { type: "json" };

const logger = log("lexicon");

export type Deps = {
  readonly lexicon: Lexicon;
  readonly cache: ResponseCache | null;
  /** Whether each response is checked against the spec (openapi.ts responses) */
  readonly checkResponses?: boolean;
};

/** The version each language's lexicon served when the request came, null before one's loaded */
type Versions = ReadonlyMap<Lang, string | null>;

type Env = { Variables: { versions: Versions } };

/** Browsers and caches revalidate after an hour; the edge keeps a version's for a day. */
const CACHE_CONTROL = "public, max-age=3600, s-maxage=86400";

const TAG = "Lexicon";

const NOT_FOUND = json(schemas.ApiError, "The lexicon has no such entry");
const NOT_MODIFIED = { description: "The versions are the ones If-None-Match names" } as const;

export type AppType = ReturnType<typeof createApp>;

export type { EntriesBody, EntryBody } from "./schemas.ts";
export type { Found, Lexicon } from "./ports.ts";

export function createApp(deps: Deps) {
  const responds = (specs: Parameters<typeof responses>[0]) => responses(specs, deps.checkResponses ?? false);

  /** Reads the versions of the languages the request is about, answers from the edge cache
   * or with 304 when it can, and caches what the route sends. */
  function versioned(langsOf: (c: Context<Env>) => readonly Lang[]): MiddlewareHandler<Env> {
    return async (c, next) => {
      const langs = [...new Set(langsOf(c))].sort();
      const versions = new Map(await Promise.all(langs.map(async (lang) => [lang, await deps.lexicon.served(lang)] as const)));
      c.set("versions", versions);
      const etag = `"${[...versions].map(([lang, version]) => `${lang}@${version ?? "none"}`).join(",")}"`;
      const headers = { ETag: etag, "Cache-Control": CACHE_CONTROL, Link: LICENSE_LINK };
      if (c.req.header("If-None-Match") === etag) return c.body(null, 304, headers);
      const key = cacheKey(c.req.url, etag);
      const hit = deps.cache === null ? undefined : await deps.cache.match(key);
      if (hit !== undefined) return new Response(hit.body, hit);
      await next();
      c.res = new Response(c.res.body, c.res);
      for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
      if (c.res.status === 200 && deps.cache !== null) await deps.cache.put(key, c.res.clone());
    };
  }

  return new Hono<Env>()
    .basePath("/v1")
    .use(cors({ origin: "*", allowMethods: ["GET"], exposeHeaders: ["ETag", "Link"], maxAge: 86400 }))
    .onError((error, c) => {
      if (error instanceof HTTPException && error.status < 500) return c.json({ error: error.message }, error.status);
      logger.error("request failed", { method: c.req.method, path: c.req.path, error });
      return c.json({ error: "internal error" }, 500);
    })
    .get("/openapi.json", describe({ hide: true }), (c) => c.json(spec, 200, { Link: LICENSE_LINK }))
    .get("/docs", describe({ hide: true }), (c) => c.html(scalarPage("skolia lexicon", "openapi.json")))
    .get(
      "/entries",
      describe({
        tags: [TAG],
        summary: "Entries by id",
        description: "The entries the lexicon has of those asked for. Ids it doesn't have are left out.",
      }),
      validator("query", api.EntriesQuery, badRequest()),
      versioned((c) => c.req.queries("id")?.map((id) => langOf(id as LemmaId)) ?? []),
      responds({ 200: json(api.Entries, "The entries"), 304: NOT_MODIFIED }),
      async (c) => {
        const { id: ids, include } = c.req.valid("query");
        const found = await Promise.all(
          [...c.var.versions].map(async ([lang, version]) => ({
            lang,
            found:
              version === null
                ? null
                : await deps.lexicon.byIds(
                    lang,
                    version,
                    ids.filter((id) => langOf(id) === lang),
                    include,
                  ),
          })),
        );
        return c.json(entries(found), 200);
      },
    )
    .get(
      "/entries/:id",
      describe({ tags: [TAG], summary: "An entry by id" }),
      validator("param", api.IdParam, badRequest()),
      validator("query", api.IncludeQuery, badRequest()),
      versioned((c) => [langOf(c.req.param("id") as LemmaId)]),
      responds({ 200: json(api.Entries, "The entry, first in entries"), 304: NOT_MODIFIED, 404: NOT_FOUND }),
      async (c) => {
        const { id } = c.req.valid("param");
        const lang = langOf(id);
        const version = c.var.versions.get(lang) ?? null;
        const found = version === null ? null : await deps.lexicon.byIds(lang, version, [id], c.req.valid("query").include);
        if (found === null || found.entries.length === 0) return c.json({ error: `no entry ${id}` }, 404);
        return c.json(entries([{ lang, found }]), 200);
      },
    )
    .get(
      "/lexicons/:lang",
      describe({ tags: [TAG], summary: "A language's lexicon", description: "The version it serves, its licence and its sources." }),
      validator("param", api.LangParam, badRequest()),
      versioned((c) => [schemas.Lang.parse(c.req.param("lang"))]),
      responds({ 200: json(api.About, "The lexicon"), 304: NOT_MODIFIED }),
      (c) => {
        const { lang } = c.req.valid("param");
        return c.json({ lang, version: c.var.versions.get(lang) ?? null, license: LICENSE, sources: [...sources(lang)] }, 200);
      },
    )
    .get(
      "/lexicons/:lang/lemmas/:lemma",
      describe({
        tags: [TAG],
        summary: "Entries by spelling",
        description: "The entries whose lemma is spelt so, one per part of speech: pl/lemmas/zamek has zamek the noun.",
      }),
      validator("param", api.LemmaParam, badRequest()),
      validator("query", api.IncludeQuery, badRequest()),
      versioned((c) => [schemas.Lang.parse(c.req.param("lang"))]),
      responds({ 200: json(api.Entries, "The entries"), 304: NOT_MODIFIED, 404: NOT_FOUND }),
      async (c) => {
        const { lang, lemma } = c.req.valid("param");
        const version = c.var.versions.get(lang) ?? null;
        const found = version === null ? null : await deps.lexicon.byLemma(lang, version, lemma, c.req.valid("query").include);
        if (found === null || found.entries.length === 0) return c.json({ error: `no entry is spelt ${lemma}` }, 404);
        return c.json(entries([{ lang, found }]), 200);
      },
    );
}

/** Where the edge cache keeps a response: its path and query, the query's parameters in
 * order of name then value (a lookup's entries come by id, whatever order they're asked
 * in), under the versions it was made from. */
function cacheKey(url: string, etag: string): Request {
  const { pathname, searchParams } = new URL(url);
  const query = new URLSearchParams([...searchParams].sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1)));
  return new Request(`https://cache.lexicon.invalid/${encodeURIComponent(etag)}${pathname}?${query}`);
}

/** Each language's entries, related entries and feature sets, with their credits. */
function entries(found: readonly { readonly lang: Lang; readonly found: Found | null }[]): api.EntriesBody {
  const all = found.flatMap(({ lang, found }) => (found === null ? [] : [{ lang, ...found }]));
  return {
    entries: all.flatMap(({ lang, entries, incoming }) => entries.map((e) => credited(lang, e, incoming.get(e.lemmaId)))),
    related: all.flatMap(({ lang, related }) => related.map((e) => credited(lang, e, undefined))),
    featureSets: Object.fromEntries(
      all.flatMap(({ lang, featureSets }) => (featureSets === null ? [] : [[lang, featureSets] as const])),
    ) as Partial<Record<Lang, FeatureSets>>,
  };
}

function credited(lang: Lang, entry: LexiconEntry, incoming: Incoming | undefined): api.EntryBody {
  return {
    ...entry,
    sourceUrl: wiktionaryUrl(lang, entry.lemma),
    license: LICENSE,
    attribution: [...attribution(lang, entry.lemma)],
    ...(incoming === undefined ? {} : { incoming: [...incoming.relations], incomingTruncated: incoming.truncated }),
  };
}
