import type {
  Err,
  deleteDocumentErrors,
  documentAnalysisErrors,
  documentErrors,
  documentTextErrors,
  importDocumentErrors,
  listDocumentsErrors,
  updateDocumentErrors,
} from "../endpoint-errors.ts";
// Documents: importing a text, listing and opening them, and their text, analysis and
// queueing a document again, when asked, if ingest makes other versions or its job is lost.
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as z from "zod";
import {
  MAX_TITLE_LENGTH,
  formatTag,
  isShareable,
  timestamp,
  type AvailableTag,
  type DocumentFilter,
  type DocumentId,
  type DocumentKey,
  type DocumentSummary,
  type Lang,
  type Paginated,
  type QueuePlace,
  type TagKey,
  type Tags,
  type Identity,
} from "@skolia/shared/api";
import type { PageRequest } from "@skolia/shared/page";
import { PART_ENCODING, docId, analysisKey, statusKey, textKey, versionsKey } from "@skolia/shared/keys";
import type { Status, Versions } from "@skolia/shared/schema";
import * as schemas from "@skolia/shared/schemas";
import { log } from "@skolia/util/log";
import type { BlobStore } from "../ports/blobs.ts";
import type { Clock } from "../ports/index.ts";
import type {
  DocumentEntries,
  DocumentLookup,
  DocumentStatusStore,
  DocumentTags,
  EntryFields,
  StoredDocument,
} from "../ports/documents.ts";
import type { IngestJobs, JobQueue } from "../ports/ingest.ts";
import type { Roles } from "../ports/roles.ts";
import type { UserRateLimits } from "../ports/users.ts";
import type { RateLimit } from "../rate-limits.ts";
import { overLimit } from "./rate-limits.ts";
import { NO_CONTENT, fail, ok, type BlobResult, type Failed, type Json, type NoContent, type NotModified, type Ok } from "./result.ts";

const logger = log("documents");

const NAME = /^[a-z0-9-]{1,64}$/;

type RequeueDeps = { documents: DocumentStatusStore; blobs: BlobStore; queue: JobQueue };
type DocumentDetailDeps = RequeueDeps & Clock & { documents: DocumentLookup };
type DocumentEditDeps = DocumentDetailDeps & { documents: DocumentEntries & DocumentTags };

/** A page of the entries the viewer can see that the filter keeps. Listing only reads
 * the stored status projection; refresh queues one again if it needs it. */
export async function list(
  deps: { documents: DocumentLookup },
  viewer: Identity | null,
  filter: DocumentFilter,
  page: PageRequest<DocumentKey>,
): Promise<Ok<Paginated<DocumentSummary, DocumentKey>> | Err<typeof listDocumentsErrors, 401>> {
  if (filter.mine && viewer === null) return fail(401, { code: "sign-in-required" });
  const { items, next } = await deps.documents.list(viewer?.id ?? null, filter, page);
  return ok({ items: items.map((record) => listed(record, viewer)), next });
}

export function listed(record: StoredDocument, viewer: Identity | null): DocumentSummary {
  return summarize(record, record.status, viewer);
}

/** A page of the documents the user imported, public or private. */
export async function mine(
  deps: { documents: DocumentLookup },
  user: Identity,
  page: PageRequest<DocumentKey>,
): Promise<Ok<Paginated<DocumentSummary, DocumentKey>> | Err<typeof listDocumentsErrors, 401>> {
  return list(deps, user, { tags: {}, lang: undefined, title: undefined, mine: true }, page);
}

/** A page of the tags that can be given. */
export async function tags(deps: { documents: DocumentTags }, page: PageRequest<TagKey>): Promise<Ok<Paginated<AvailableTag, TagKey>>> {
  return ok(await deps.documents.tags(page));
}

/** A 400 naming the first of the tags skolia doesn't have, or null if it has them all. */
async function unknownTag(
  deps: { documents: DocumentTags },
  tags: Tags,
): Promise<Failed<400, { code: "unknown-tag"; tag: string }> | null> {
  const given = Object.entries(tags).map(([kind, value]) => ({ kind, value }));
  if (given.length === 0) return null;
  const known = new Set((await deps.documents.known(given)).map(formatTag));
  const unknown = given.map(formatTag).find((tag) => !known.has(tag));
  return unknown === undefined ? null : fail(400, { code: "unknown-tag", tag: unknown });
}

/** 202 if the text is queued, 200 if it's already here and not failed (a failed import is
 * retried by importing the same text again). A text someone else imported gets the user's
 * own entry, with their title, visibility and licence. Each import counts against the
 * user's importRate; 429 past it. */
export async function importText(
  deps: DocumentEditDeps & { users: UserRateLimits; roles: Roles; importRate: RateLimit },
  user: Identity,
  body: z.output<typeof schemas.ImportRequest>,
): Promise<Json<DocumentSummary, 200> | Json<DocumentSummary, 202> | Err<typeof importDocumentErrors, 400 | 429>> {
  const unknown = await unknownTag(deps, body.tags);
  if (unknown !== null) return unknown;
  const limited = await overLimit(deps, user, "import", deps.importRate);
  if (limited !== null) return limited;
  const fields: EntryFields = {
    title: body.title?.trim().slice(0, MAX_TITLE_LENGTH) || firstWords(body.text),
    visibility: body.visibility,
    licence: body.licence,
    author: body.author?.trim() || null,
    source: body.source ?? null,
    tags: body.tags,
  };
  const id = await docId(body.lang, body.text);
  const known = await deps.documents.has(id);
  const own = known ? await ownEntry(deps, id, user) : null;
  const versions = versionsOf(deps.blobs);
  // A new text's run starts before its row is added: if starting it fails, there's no
  // document waiting on a run that never comes, and importing it again starts over
  const started = known
    ? null
    : await (async () => {
        await deps.blobs.put(textKey(id), body.text, "text/plain; charset=utf-8");
        return await requeue(deps, { id, lang: body.lang }, versions, null, deps.now(), "imported");
      })();
  if (own === null) {
    await deps.documents.add(
      { id, lang: body.lang, words: countWords(body.text) },
      { id, user: user.id, importedAt: timestamp(deps.now()), ...fields },
    );
  } else if (own.visibility === "private" && fields.visibility === "public") {
    await deps.documents.update(id, user.id, { ...fields, title: own.title, tags: own.tags });
  }
  const record = await ownEntry(deps, id, user);
  if (!record) throw new Error(`document ${id} vanished after insert`);
  if (started !== null) return { status: 202, body: summarize(record, started, user) };
  const summary = await refreshed(deps, record, versions, user);
  if (summary.state !== "failed") return ok(summary);
  const queued = await requeue(deps, record, versions, await readStatus(deps.blobs, id), deps.now(), "reimported");
  return { status: 202, body: summarize(record, queued, user) };
}

/** A user changes the title, licence, author, source, visibility or tags of their own entry. */
export async function update(
  deps: DocumentEditDeps,
  user: Identity,
  id: string,
  body: z.output<typeof schemas.DocumentUpdate>,
): Promise<Ok<DocumentSummary> | Err<typeof updateDocumentErrors, 400 | 403 | 404>> {
  const record = await findDocument(deps, id, user);
  if (!record) return noSuchDocument();
  if (record.user !== user.id) return fail(403, { code: "not-document-importer" });
  const fields: EntryFields = {
    title: body.title ?? record.title,
    visibility: body.visibility ?? record.visibility,
    licence: body.licence ?? record.licence,
    author: body.author === undefined ? record.author : body.author || null,
    source: body.source === undefined ? record.source : body.source,
    tags: body.tags ?? record.tags,
  };
  if (fields.visibility === "public" && !isShareable(fields.licence)) {
    return fail(400, { code: "sharing-license-required" });
  }
  const unknown = await unknownTag(deps, fields.tags);
  if (unknown !== null) return unknown;
  await deps.documents.update(record.id, user.id, fields);
  return ok(summarize({ ...record, ...fields }, await readStatus(deps.blobs, record.id), user));
}

/** A user deletes their entry. The text, its analyses stay, so importing it
 * again needn't analyse it again. */
export async function remove(
  deps: { documents: DocumentEntries & DocumentLookup },
  user: Identity,
  id: string,
): Promise<NoContent | Err<typeof deleteDocumentErrors, 403 | 404>> {
  const record = await findDocument(deps, id, user);
  if (!record) return noSuchDocument();
  if (record.user !== user.id) return fail(403, { code: "not-document-importer" });
  await deps.documents.remove(record.id, user.id);
  return NO_CONTENT;
}

/** The entry as it stands; it isn't queued again here (refresh does that). */
export async function get(
  deps: DocumentDetailDeps,
  id: string,
  viewer: Identity | null,
): Promise<Ok<DocumentSummary> | Err<typeof documentErrors, 404>> {
  const record = await findDocument(deps, id, viewer);
  if (!record) return noSuchDocument();
  return ok(await withQueue(deps, record, summarize(record, await readStatus(deps.blobs, record.id), viewer)));
}

/** The entry, after queueing it again if ingest now makes other versions or its run seems
 * lost. Anyone who can see it may ask: it's queued only when it needs it. */
export async function refresh(
  deps: DocumentDetailDeps,
  id: string,
  viewer: Identity | null,
): Promise<Ok<DocumentSummary> | Err<typeof documentErrors, 404>> {
  const record = await findDocument(deps, id, viewer);
  if (!record) return noSuchDocument();
  return ok(await withQueue(deps, record, await refreshed(deps, record, versionsOf(deps.blobs), viewer)));
}

/** The summary with where the viewer's own queued document is in its queue. */
async function withQueue(deps: { queue: JobQueue }, record: StoredDocument, summary: DocumentSummary): Promise<DocumentSummary> {
  if (summary.mine && summary.state === "queued") {
    const jobs = await deps.queue.jobs(record.lang);
    summary.queue = placeIn(jobs, record.id);
    // The run writes no status while the container works on it: the container says
    if (jobs?.running.includes(record.id)) summary.state = "analysing";
  }
  return summary;
}

/** No container running means one is about to start for this document. */
export function placeIn(jobs: Pick<IngestJobs, "loading" | "running" | "waiting"> | null, id: DocumentId): QueuePlace {
  if (jobs === null) return { starting: true, ahead: null };
  const index = [...jobs.running, ...jobs.waiting].indexOf(id);
  return { starting: jobs.loading, ahead: index < 0 ? null : index };
}

/** The id is the text's hash, so the text at this URL never changes. */
export async function text(
  deps: { documents: DocumentLookup; blobs: BlobStore },
  id: string,
  viewer: Identity | null,
  ifNoneMatch: string | undefined,
): Promise<BlobResult | NotModified | Err<typeof documentTextErrors, 404 | 500>> {
  const record = await findDocument(deps, id, viewer);
  if (!record) return noSuchDocument();
  return stored(deps, textKey(record.id), undefined, ifNoneMatch, fail(500, { code: "internal-error" }));
}

/** A document's analysis at a URL keyed by its immutable version name. */
export async function part(
  deps: { documents: DocumentLookup; blobs: BlobStore },
  id: string,
  viewer: Identity | null,
  name: string,
  ifNoneMatch: string | undefined,
): Promise<BlobResult | NotModified | Err<typeof documentAnalysisErrors, 404>> {
  const record = await findDocument(deps, id, viewer);
  if (!record || !NAME.test(name)) return noSuchDocument();
  return stored(deps, analysisKey(record.id, name), PART_ENCODING, ifNoneMatch, fail(404, { code: "analysis-not-found", name }));
}

/** The blob at a key that never changes, or 304 without reading it when the client has it. */
async function stored<Missing extends Json<unknown, ContentfulStatusCode>>(
  deps: { blobs: BlobStore },
  key: string,
  encoding: typeof PART_ENCODING | undefined,
  ifNoneMatch: string | undefined,
  missing: Missing,
): Promise<BlobResult | NotModified | Missing> {
  const etag = `"${key}"`;
  if (ifNoneMatch?.split(",").some((tag) => tag.trim().replace(/^W\//u, "") === etag)) return { status: 304, etag, encoding };
  const blob = await deps.blobs.get(key);
  return blob ? { status: 200, etag, blob, encoding } : missing;
}

export function noSuchDocument(): Err<typeof documentErrors, 404> {
  return fail(404, { code: "document-not-found" });
}

/** The entry the viewer sees: theirs, else a public one. A text private to others is
 * unknown to them. */
export async function findDocument(
  deps: { documents: DocumentLookup },
  id: string,
  viewer: Identity | null,
): Promise<StoredDocument | null> {
  const parsed = schemas.DocumentId.safeParse(id);
  return parsed.success ? deps.documents.visible(parsed.data, viewer?.id ?? null) : null;
}

async function ownEntry(deps: { documents: DocumentLookup }, id: DocumentId, user: Identity): Promise<StoredDocument | null> {
  const entry = await deps.documents.visible(id, user.id);
  return entry?.user === user.id ? entry : null;
}

/** The summary, after queueing the document again if ingest now produces other
 * versions, or if its run seems lost. */
async function refreshed(
  deps: RequeueDeps & Clock,
  record: StoredDocument,
  versions: VersionsOf,
  viewer: Identity | null,
): Promise<DocumentSummary> {
  const status = await readStatus(deps.blobs, record.id);
  const now = deps.now();
  if (status !== null) {
    const reason = isStuck(status, now) ? "stuck" : isOutdated(status, await versions(record.lang)) ? "outdated" : null;
    if (reason !== null) return summarize(record, await requeue(deps, record, versions, status, now, reason), viewer);
  }
  return summarize(record, status, viewer);
}

type RequeueReason = "imported" | "reimported" | "stuck" | "outdated";

/** Queues the document and starts a run of ingest for it, keeping the last analysis readable
 * until the new one is ready. The queued status is written before the run exists, which
 * writes the status from then on. */
async function requeue(
  deps: RequeueDeps,
  record: Pick<StoredDocument, "id" | "lang">,
  versions: VersionsOf,
  status: Status | null,
  at: Date,
  reason: RequeueReason,
): Promise<Status> {
  logger.info("queueing document", {
    doc: record.id,
    lang: record.lang,
    reason,
    previous: status?.state ?? null,
    since: status?.updated ?? null,
  });
  const queued: Status = {
    state: "queued",
    updated: timestamp(at),
    ...(status?.artifacts === undefined ? {} : { artifacts: status.artifacts }),
  };
  await publishStatus(deps, record.id, queued);
  await deps.queue.start(record.id, record.lang, await versions(record.lang));
  return queued;
}

/** A ready document whose analysis isn't what ingest makes now. Unknown
 * until ingest has published its versions. */
export function isOutdated(status: Status, latest: Versions | null): boolean {
  if (status.state !== "ready" || latest === null) return false;
  return nameOf(status.artifacts.analysis) !== latest.analysis;
}

/** Longer than a job takes, waiting its turn included, short of a run's retries. A document
 * queued for this long may have lost its run:
 * its start failed, or its job was on the queue runs replaced. Starting it again is safe: a run
 * under way is left alone, one that ended is run again, and ingest reuses blobs that already
 * exist. */
export const STUCK_AFTER_MS = 30 * 60 * 1000;

export function isStuck(status: Status, at: Date): boolean {
  if (status.state !== "queued") return false;
  const updated = Date.parse(status.updated);
  return Number.isNaN(updated) || at.getTime() - updated > STUCK_AFTER_MS;
}

/** The name in a blob key: doc/{id}/analysis/{name}.json.br -> {name}. */
export function nameOf(key: string | undefined): string | undefined {
  return key?.match(/\/([^/]+)\.json\.br$/u)?.[1];
}

type VersionsOf = (lang: Lang) => Promise<Versions | null>;

/** Each language's versions, read once per request. Null until ingest has started and
 * published them; documents aren't queued again until then. */
function versionsOf(blobs: BlobStore): VersionsOf {
  const read = new Map<Lang, Promise<Versions | null>>();
  return (lang) => {
    let versions = read.get(lang);
    if (versions === undefined) {
      versions = blobs.get(versionsKey(lang)).then((blob) => (blob ? parseVersions(new TextDecoder().decode(blob.body)) : null));
      read.set(lang, versions);
    }
    return versions;
  };
}

/** Malformed JSON, or JSON that doesn't fit the schema, counts as missing. */
export function parseJson<T extends z.ZodType>(schema: T, raw: string): z.output<T> | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseVersions(raw: string): Versions | null {
  return parseJson(schemas.Versions, raw);
}

function summarize(
  { user, importerName, status: _status, ...record }: StoredDocument,
  status: Status | null,
  viewer: Identity | null,
): DocumentSummary {
  const summary: DocumentSummary = {
    ...record,
    importer: { id: user, name: importerName },
    mine: user === viewer?.id,
    state: status?.state ?? "failed",
  };
  const analysis = nameOf(status?.artifacts?.analysis);
  if (analysis !== undefined) summary.reading = { analysis };
  if (status === null) summary.error = { kind: "status-unavailable" };
  else if (status.state === "failed") summary.error = status.error;
  return summary;
}

/** Publish the detail blob and its list projection together. Callers retry on failure. */
export async function publishStatus(
  deps: { blobs: BlobStore; documents: DocumentStatusStore },
  id: DocumentId,
  status: Status,
): Promise<void> {
  await deps.blobs.put(statusKey(id), JSON.stringify(status), "application/json");
  await deps.documents.setStatus(id, status);
}

export async function readStatus(blobs: BlobStore, id: DocumentId): Promise<Status | null> {
  const blob = await blobs.get(statusKey(id));
  if (!blob) return null;
  return parseStatus(new TextDecoder().decode(blob.body));
}

/** The status blob ingest writes. */
export function parseStatus(raw: string): Status | null {
  return parseJson(schemas.Status, raw);
}

export function countWords(text: string): number {
  return text.split(/\s+/u).filter((w) => /\p{L}/u.test(w)).length;
}

const TITLE_WORDS = 6;
const TITLE_CHARS = 60;

function firstWords(text: string): string {
  const all = text.trim().split(/\s+/u);
  const words = all.slice(0, TITLE_WORDS).join(" ");
  if (words.length > TITLE_CHARS) return `${words.slice(0, TITLE_CHARS)}…`;
  return all.length > TITLE_WORDS ? `${words}…` : words;
}
