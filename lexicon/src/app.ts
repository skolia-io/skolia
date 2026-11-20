import { Hono, type Context, type MiddlewareHandler } from "hono";
import { etag } from "hono/etag";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { langOf, type Lang } from "@skolia/shared/api";
import type { Entry } from "@skolia/shared/schema";
import * as schemas from "@skolia/shared/schemas";
import { badRequest, describe, json, responses, scalarPage, validator } from "@skolia/util/openapi";
import { log } from "@skolia/util/log";
import { LICENSE, LICENSE_LINK, attribution, sources, wiktionaryUrl } from "./licence.ts";
import type { Found, Incoming, Lexicon } from "./ports.ts";
import * as api from "./schemas.ts";
import spec from "../openapi.json" with { type: "json" };

const logger = log("lexicon");

export type Deps = {
  readonly lexicon: Lexicon;
  /** Whether each response is checked against the spec (openapi.ts responses) */
  readonly checkResponses?: boolean;
};

type Env = { Variables: { version: string } };

const NO_STORE = "no-store";
const PINNED_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const EDGE_CACHE_CONTROL = "public, max-age=86400";

const conditional = etag({
  weak: true,
  retainedHeaders: ["Cache-Control", "ETag", "Link", "Access-Control-Allow-Origin", "Access-Control-Expose-Headers", "Vary"],
});

const TAG = "Lexicon";

const NOT_FOUND = json(schemas.ApiError, "The lexicon has no such entry");
const VERSION_CHANGED = json(schemas.ApiError, "The requested version is no longer served");
const NOT_MODIFIED = { description: "The representation matches If-None-Match" } as const;

export type AppType = ReturnType<typeof createApp>;

export type { EntriesBody, EntryBody } from "./schemas.ts";
export type { Found, Lexicon } from "./ports.ts";

export function createApp(deps: Deps) {
  const responds = (specs: Parameters<typeof responses>[0]) => responses(specs, deps.checkResponses ?? false);

  function versioned(langOfRequest: (c: Context<Env>) => Lang): MiddlewareHandler<Env> {
    return async (c, next) => {
      const lang = langOfRequest(c);
      const version = await deps.lexicon.served(lang);
      const requested = c.req.query("version");
      const changed = () => c.json({ error: "lexicon version changed; fetch the current version and retry" }, 409);
      if (requested !== undefined && requested !== version) return changed();
      if (version === null) return c.json({ error: "no lexicon loaded" }, 404);
      c.set("version", version);
      await next();
      // Once loaded points at a new version, the loader can delete the previous rows.
      // Discard any lookup that overlapped that switch before publishing it to the cache.
      if ((await deps.lexicon.served(lang)) !== version) return changed();
      if (requested !== undefined && (c.res.status === 200 || c.res.status === 304)) {
        c.header("Cache-Control", PINNED_CACHE_CONTROL);
        c.header("Cloudflare-CDN-Cache-Control", EDGE_CACHE_CONTROL);
      }
    };
  }

  return new Hono<Env>()
    .basePath("/v1")
    .use(async (c, next) => {
      c.header("Cache-Control", NO_STORE);
      c.header("Link", LICENSE_LINK);
      await next();
    })
    .use(cors({ origin: "*", allowMethods: ["GET"], exposeHeaders: ["ETag", "Link"], maxAge: 86400 }))
    .onError((error, c) => {
      if (error instanceof HTTPException && error.status < 500) return c.json({ error: error.message }, error.status);
      logger.error("request failed", { method: c.req.method, path: c.req.path, error });
      return c.json({ error: "internal error" }, 500);
    })
    .get("/openapi.json", describe({ hide: true }), (c) => c.json(spec, 200, { Link: LICENSE_LINK }))
    .get("/docs", describe({ hide: true }), (c) => c.html(scalarPage("skolia lexicon", "openapi.json")))
    .get(
      "/entries/:id",
      describe({ tags: [TAG], summary: "An entry by id" }),
      validator("param", api.IdParam, badRequest()),
      validator("query", api.IncludeQuery, badRequest()),
      responds({ 200: json(api.Entries, "The entry, first in entries"), 304: NOT_MODIFIED, 404: NOT_FOUND, 409: VERSION_CHANGED }),
      versioned((c) => langOf(schemas.LemmaId.parse(c.req.param("id")))),
      conditional,
      async (c) => {
        const { id } = c.req.valid("param");
        const lang = langOf(id);
        const found = await deps.lexicon.byIds(lang, c.var.version, [id], c.req.valid("query").include);
        if (found.entries.length === 0) return c.json({ error: `no entry ${id}` }, 404);
        return c.json(entries(lang, found), 200);
      },
    )
    .get(
      "/lexicons/:lang",
      describe({ tags: [TAG], summary: "A language's lexicon", description: "The version it serves, its licence and its sources." }),
      validator("param", api.LangParam, badRequest()),
      responds({ 200: json(api.About, "The lexicon") }),
      async (c) => {
        const { lang } = c.req.valid("param");
        return c.json({ lang, version: await deps.lexicon.served(lang), license: LICENSE, sources: [...sources(lang)] }, 200);
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
      responds({ 200: json(api.Entries, "The entries"), 304: NOT_MODIFIED, 404: NOT_FOUND, 409: VERSION_CHANGED }),
      versioned((c) => schemas.Lang.parse(c.req.param("lang"))),
      conditional,
      async (c) => {
        const { lang, lemma } = c.req.valid("param");
        const found = await deps.lexicon.byLemma(lang, c.var.version, lemma, c.req.valid("query").include);
        if (found.entries.length === 0) return c.json({ error: `no entry is spelt ${lemma}` }, 404);
        return c.json(entries(lang, found), 200);
      },
    );
}

function entries(lang: Lang, found: Found): api.EntriesBody {
  return {
    entries: found.entries.map((entry) => credited(lang, entry, found.incoming.get(schemas.LemmaId.parse(entry.lemma_id)))),
    related: found.related.map((entry) => credited(lang, entry, undefined)),
    featureSets: found.featureSets === null ? {} : { [lang]: found.featureSets },
  };
}

function credited(lang: Lang, entry: Entry, incoming: Incoming | undefined): api.EntryBody {
  return {
    ...entry,
    sourceUrl: wiktionaryUrl(lang, entry.lemma),
    license: LICENSE,
    attribution: [...attribution(lang, entry.lemma)],
    ...(incoming === undefined ? {} : { incoming: [...incoming.relations], incomingTruncated: incoming.truncated }),
  };
}
