import assert from "node:assert/strict";
import { after, before, beforeEach } from "node:test";
import { brotliCompressSync } from "node:zlib";
import { hc, type ClientResponse } from "hono/client";
import * as schemas from "@skolia/shared/schemas";
import type { DocumentId, DocumentKey, DocumentSummary, Lang, NewClozeInput, Paginated } from "@skolia/shared/api";
import type { Versions } from "@skolia/shared/schema";
import { partKey, statusKey, versionsKey } from "@skolia/shared/keys";
import { allPages, encodeCursor, type Cursor } from "@skolia/shared/page";
import { createApp, type AppType } from "../app.ts";
import type { Auth, IngestJobs, JobQueue } from "../ports.ts";
import type { IngestParams } from "@skolia/ingest/rpc";
import { sql } from "@skolia/util/sql";
import { IngestRuns, D1Documents, D1Lexicon, DurableObjectUsers, R2Blobs, lexiconsOf, prepare, type JobsOf } from "../worker/adapters.ts";
import { D1IngestHistory } from "@skolia/ingest/history";
import { ORIGIN, startLocal, type Local } from "./harness.ts";
import { body, expectStatus } from "./responses.ts";

export let local: Local;

/** Signed in as the user who imports in importText. */
export let importer: Headers;

export function useLocal(): void {
  before(async () => {
    local = await startLocal();
  });
  beforeEach(async () => {
    await local.reset();
    importer = await local.signIn((await local.signUp({ name: "Ivy", email: "ivy@example.com" })).id);
  });
  after(() => local?.close());
}

export const NOW = "2026-11-04T00:00:00Z";
export const TEXT = "Idę do starego psa.";
export const ALICE = { name: "Alice", email: "alice@example.com" };

/** jobsOf: what the ingest container answers about its jobs; none is running unless given. */
export function setup({ auth = local.auth, at = NOW, jobsOf = async () => null }: { auth?: Auth; at?: string; jobsOf?: JobsOf } = {}) {
  const { env } = local;
  return createApp({
    auth,
    users: new DurableObjectUsers(env.USER),
    lexicon: new D1Lexicon(lexiconsOf(env)),
    documents: new D1Documents(env.DB.withSession("first-primary")),
    blobs: new R2Blobs(env.BLOBS),
    queue: new RecordingStarts(new IngestRuns(env.INGEST_WORKFLOW, jobsOf), local.started),
    ingestHistory: new D1IngestHistory(env.INGEST_DB),
    version: "v1.2.3",
    now: () => new Date(at),
    checkResponses: true,
  });
}

export type App = ReturnType<typeof setup>;

/** Notes each run of ingest the API asks for, then starts it */
class RecordingStarts implements JobQueue {
  private readonly runs: JobQueue;
  private readonly started: IngestParams[];

  constructor(runs: JobQueue, started: IngestParams[]) {
    this.runs = runs;
    this.started = started;
  }

  async start(doc: DocumentId, lang: Lang, versions: Versions | null): Promise<void> {
    await this.runs.start(doc, lang, versions);
    this.started.push({ doc, lang });
  }

  jobs(lang: Lang): Promise<IngestJobs | null> {
    return this.runs.jobs(lang);
  }
}

/** What a language's ingest container answers, idle unless given */
export function ingestJobs(fields: Partial<IngestJobs> = {}): IngestJobs {
  return { loading: false, running: [], waiting: [], jobs: [], ...fields };
}

export async function putJson(key: string, value: unknown): Promise<void> {
  const id = key.match(/^doc\/([a-f0-9]{64})\/status\.json$/u)?.[1];
  if (id !== undefined) {
    await local.env.DOCUMENT_STATUS.publish(schemas.DocumentId.parse(id), schemas.Status.parse(value));
  } else {
    await new R2Blobs(local.env.BLOBS).put(key, JSON.stringify(value), "application/json");
  }
}

/** The API's typed client (hono/client), sending to the test app, signed in with headers. */
export function client(app: App, headers?: Headers) {
  const fetch = (input: string | URL | Request, init?: RequestInit) => app.request(input, init);
  return hc<AppType>(ORIGIN, { headers: Object.fromEntries(headers ?? []), fetch }).api;
}

/** A JSON request the typed client won't send: invalid input, for the API's validation. A
 * string body is sent as it is, for malformed JSON. */
export function raw(app: App, method: string, path: string, headers: Headers | undefined, body: unknown) {
  const allHeaders = new Headers(headers);
  allHeaders.set("content-type", "application/json");
  return app.request(`${ORIGIN}${path}`, { method, headers: allHeaders, body: typeof body === "string" ? body : JSON.stringify(body) });
}

/** Lexicon rows as infra/load-lexicon.py loads them, and the version that serves. */
export interface TestEntry {
  lemmaId: string;
  lemma: string;
  upos: string;
  gloss: string;
  pronunciations?: unknown[];
  /** Compact, as in D1: [{ homonym, forms: [["psa", [0, 1]]] }] */
  paradigms?: unknown[];
}

/** Loads a lexicon version with its feature sets, by id, and makes it the one served. */
export async function loadLexicon(
  lang: Lang,
  version: string,
  entries: TestEntry[],
  featureSets: Record<string, string>[] = [],
): Promise<void> {
  const db = lexiconsOf(local.env)[lang];
  await db.batch([
    ...entries.map((e) =>
      prepare(
        db,
        sql`INSERT INTO entry (lemma_id, version, lemma, upos, senses, relations, pronunciations, paradigms) VALUES ${sql.tuple([
          e.lemmaId,
          version,
          e.lemma,
          e.upos,
          JSON.stringify([{ gloss: e.gloss, tags: [] }]),
          sql`'[]'`,
          JSON.stringify(e.pronunciations ?? []),
          JSON.stringify(e.paradigms ?? []),
        ])}`,
      ),
    ),
    ...featureSets.flatMap((set, id) =>
      Object.entries(set).map(([feature, value]) =>
        prepare(db, sql`INSERT INTO featureset (version, id, feature, value) VALUES ${sql.tuple([version, id, feature, value])}`),
      ),
    ),
    prepare(db, sql`INSERT INTO loaded (id, version) VALUES (1, ${version}) ON CONFLICT (id) DO UPDATE SET version = excluded.version`),
  ]);
}

export function importText(
  app: App,
  text = TEXT,
  {
    headers = importer,
    ...fields
  }: { headers?: HeadersInit; visibility?: string; licence?: string; author?: string; source?: string } = {},
) {
  const allHeaders = new Headers(headers);
  allHeaders.set("content-type", "application/json");
  return app.request(`${ORIGIN}/api/documents`, {
    method: "POST",
    headers: allHeaders,
    body: JSON.stringify({ title: "", text, lang: "pl", ...fields }),
  });
}

/** Imports, as the user, a new text with each sentence where it starts and spaces around
 * them, for cloze cards made from it. */
export async function importSentences(
  app: App,
  headers: Headers,
  sentences: readonly Pick<NewClozeInput, "sentence" | "sentenceStart">[],
  fields: { visibility?: "private" | "public"; licence?: "cc0" } = {},
): Promise<DocumentId> {
  const text = sentences.reduce(
    (t, { sentence, sentenceStart }) =>
      t.slice(0, sentenceStart).padEnd(sentenceStart) + sentence + t.slice(sentenceStart + sentence.length),
    "",
  );
  return (await body("import", client(app, headers).documents.$post({ json: { text, lang: "pl", ...fields } }), 202)).id;
}

/** The ids of every document the viewer sees, from all the list's pages. */
export async function listed(app: App, headers?: Headers): Promise<DocumentId[]> {
  const documents = await allPages((after?: Cursor<DocumentKey>) =>
    body("list", client(app, headers).documents.$get({ query: { after } })),
  );
  return documents.map((d) => d.id);
}

/** Every item of a list, following its pages from the first, after checking that each
 * page but the last is full and the last has some items unless the list is empty. */
export async function walk<T, K>(
  limit: number,
  fetchPage: (after: Cursor<K> | undefined) => Promise<Paginated<T, K>>,
): Promise<readonly T[]> {
  const pages = async (after: Cursor<K> | undefined): Promise<readonly Paginated<T, K>[]> => {
    const page = await fetchPage(after);
    return page.next === null ? [page] : [page, ...(await pages(page.next))];
  };
  const all = await pages(undefined);
  const sizes = all.map((page) => page.items.length);
  const last = sizes.at(-1) ?? 0;
  assert.deepEqual(
    sizes.slice(0, -1),
    sizes.slice(0, -1).map(() => limit),
    `page sizes ${sizes.join(", ")}`,
  );
  assert.ok(last <= limit && (last > 0 || all.length === 1), `page sizes ${sizes.join(", ")}`);
  return all.flatMap((page) => page.items);
}

/** A string passed off as any list's cursor, to see the API refuse what the types would. */
export function forged(text: string): Cursor<never> {
  return text as Cursor<never>;
}

/** Checks that a list refuses an after it didn't give, and a limit out of its range. */
export async function refusesBadPages(
  max: number,
  list: (query: { readonly after?: Cursor<never>; readonly limit?: string }) => Promise<ClientResponse<unknown, number, string>>,
): Promise<void> {
  for (const after of [forged("nope"), forged(encodeCursor([1.5]))]) {
    const refused = await expectStatus(`after ${after}`, list({ after }), 400);
    assert.deepEqual(await refused.json(), { error: "after isn't a cursor this list gave" });
  }
  for (const limit of [String(max + 1), "0"]) {
    const refused = await expectStatus(`limit ${limit}`, list({ limit }), 400);
    assert.deepEqual(await refused.json(), { error: `limit must be 1 to ${max}` });
  }
}

/** A ready document whose analysis and bundle were made by version v, as ingest leaves it. */
export async function readyAt(id: DocumentId, v: string): Promise<void> {
  const blobs = new R2Blobs(local.env.BLOBS);
  for (const [part, name] of [
    ["analysis", `s2-a${v}`],
    ["bundle", `b1-a${v}-l1`],
  ] as const) {
    await blobs.put(partKey(id, part, name), new Uint8Array(brotliCompressSync(`{"${part}":"${v}"}`)), "application/json");
  }
  await putJson(statusKey(id), {
    state: "ready",
    updated: new Date(NOW).toISOString(),
    artifacts: {
      analyzer: `pl/${v}`,
      lexicon: "lex/1",
      analysis: partKey(id, "analysis", `s2-a${v}`),
      bundle: partKey(id, "bundle", `b1-a${v}-l1`),
    },
  });
}

export function publish(v: string): Promise<void> {
  return putJson(versionsKey("pl"), { analyzer: `pl/${v}`, lexicon: "lex/1", analysis: `s2-a${v}`, bundle: `b1-a${v}-l1` });
}

/** The summary as the importer sees it, since a private document is only theirs to see. */
export async function summaryOf(app: App, id: string, headers: HeadersInit = importer): Promise<DocumentSummary> {
  return (await (await app.request(`/api/documents/${id}`, { headers })).json()) as DocumentSummary;
}
