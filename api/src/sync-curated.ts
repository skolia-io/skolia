// Makes the curated user's documents match curated/: imports each text there publicly,
// updates the title, licence, author, source or tags of those already imported, and deletes the
// curated user's documents that aren't there any more. A document's id is its text's hash,
// so an edited text is a new document and the old one is deleted. Each text's annotations are added, and those not in its file any more removed;
// an annotation's id is a hash of what it says, so an edited one is removed and added again.
// With --check, only lists what it would do, and fails if that's anything.
// curated/{lang}/{name}.yaml: one text, of a kind (curated-kinds.ts).
// With --concurrency, makes that many changes at once (default CONCURRENCY). With --sample,
// syncs only that many of the texts (sampleCurated), as previews do.
// usage: SYNC_CURATED_API_KEY=<key> node src/sync-curated.ts <base url> <curated dir> [--check] [--concurrency <n>] [--sample <n>]
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { hc, type ClientRequestOptions } from "hono/client";
import { parse as parseYaml } from "yaml";
import * as z from "zod";
import {
  ANNOTATION_BATCH,
  ANNOTATION_PAGE,
  DOCUMENT_PAGE,
  LANGS,
  type Annotation,
  type AnnotationId,
  type AnnotationKey,
  type DocumentId,
  type DocumentKey,
  type DocumentSummary,
  type DocumentUpdate,
  type Lang,
  type NewAnnotation,
  type Tags,
} from "@skolia/shared/api";
import { annotationId } from "@skolia/shared/annotations";
import { docId } from "@skolia/shared/keys";
import { allPages, type Cursor } from "@skolia/shared/page";
import * as schemas from "@skolia/shared/schemas";
import { GraphBuilder, runGraph, type Graph } from "@skolia/util/graph";
import type { AppType } from "./app.ts";
import { API_KEY_HEADER } from "./auth.ts";
import { CuratedSpec, resolve, type Resolved } from "./curated-kinds.ts";
import { describeError } from "@skolia/util/errors";
import { trimSpans } from "./curated-spans.ts";
import { runScript, scriptLog, since } from "./script-log.ts";

const log = scriptLog("sync-curated");

/** A curated file, checked but not yet resolved. */
export interface CuratedFile {
  readonly path: string;
  readonly lang: Lang;
  readonly spec: CuratedSpec;
}

/** An annotation on a curated text: the request that adds it, and the id the API gives it. */
export type CuratedAnnotation = {
  readonly id: AnnotationId;
  readonly request: NewAnnotation;
};

export type Curated = {
  readonly path: string;
  readonly id: DocumentId;
  readonly request: z.output<typeof schemas.ImportRequest>;
  readonly annotations: readonly CuratedAnnotation[];
};

export type Change =
  | { kind: "import"; text: Curated }
  | { kind: "update"; text: Curated; id: DocumentId; update: DocumentUpdate }
  | { kind: "delete"; document: DocumentSummary }
  | { kind: "annotate"; text: Curated; annotations: readonly CuratedAnnotation[] }
  | { kind: "unannotate"; text: Curated; annotation: Annotation };

/** How many changes are made at once, unless --concurrency says */
const CONCURRENCY = 8;

/** A curated file's YAML, checked against its kind. Throws, naming the file, if it isn't one. */
export function parseCurated(path: string, lang: Lang, raw: string): CuratedFile {
  let yaml: unknown;
  try {
    yaml = parseYaml(raw, { merge: true });
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const spec = CuratedSpec.safeParse(yaml);
  if (!spec.success) {
    const issue = spec.error.issues[0];
    throw new Error(`${path}: ${issue ? `${issue.path.join(".") || "kind"}: ${issue.message}` : "not a curated file"}`);
  }
  return { path, lang, spec: spec.data };
}

/** A resolved text as a public import, trimmed, with its annotations moved to where they
 * are in the trimmed text. Throws, naming the file, if it isn't one or has the same
 * annotation twice. */
export async function toCurated(path: string, lang: Lang, resolved: Resolved): Promise<Curated> {
  const { text, spans } = trimSpans(resolved.text, resolved.annotations);
  const request = schemas.ImportRequest.safeParse({ ...resolved, text, lang, visibility: "public" });
  if (!request.success) throw new Error(`${path}: ${request.error.issues[0]?.message ?? "not a valid import"}`);
  const annotations = await Promise.all(
    spans.map(async (annotation) => {
      const parsed = schemas.NewAnnotation.safeParse(annotation);
      if (!parsed.success)
        throw new Error(
          `${path}: the annotation at ${annotation.start}-${annotation.end}: ${parsed.error.issues[0]?.message ?? "not valid"}`,
        );
      return { id: await annotationId(parsed.data), request: annotation };
    }),
  );
  const twice = annotations.find((a, i) => annotations.findIndex((b) => b.id === a.id) !== i);
  if (twice) throw new Error(`${path}: the same annotation twice at ${twice.request.start}-${twice.request.end}`);
  return { path, id: await docId(lang, text), request: request.data, annotations };
}

/** Every file in curated/{lang}/, checked. */
export async function readCurated(dir: string): Promise<CuratedFile[]> {
  const langs = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const files = await Promise.all(
    langs.map(async (entry) => {
      const lang = LANGS.find((l) => l === entry.name);
      if (lang === undefined) throw new Error(`${join(dir, entry.name)}: not a language (${LANGS.join(", ")})`);
      const names = (await readdir(join(dir, lang))).sort();
      return Promise.all(
        names.map(async (name) => {
          const path = join(dir, lang, name);
          if (!name.endsWith(".yaml")) throw new Error(`${path}: not a .yaml file`);
          return parseCurated(path, lang, await readFile(path, "utf8"));
        }),
      );
    }),
  );
  return files.flat();
}

/** n of the files, the same each time, spread over their languages, kinds and whether they
 * have annotations: a file from each of those groups in turn, each group in path order. */
export function sampleCurated(files: readonly CuratedFile[], n: number): CuratedFile[] {
  const groups = files
    .toSorted((a, b) => a.path.localeCompare(b.path))
    .reduce((byGroup, file) => {
      const annotated = file.spec.kind === "inline" && Object.keys(file.spec.annotations).length > 0;
      const group = `${file.lang} ${file.spec.kind} ${annotated}`;
      return byGroup.set(group, [...(byGroup.get(group) ?? []), file]);
    }, new Map<string, readonly CuratedFile[]>());
  const ordered = [...groups].toSorted(([a], [b]) => a.localeCompare(b)).map(([, group]) => group);
  const rounds = Math.max(0, ...ordered.map((group) => group.length));
  return Array.from({ length: rounds }, (_, round) => ordered.flatMap((group) => group[round] ?? []))
    .flat()
    .slice(0, n);
}

/** The files' texts. Throws, naming each file, if any isn't a valid import or two are the
 * same text. */
export async function resolveCurated(files: readonly CuratedFile[]): Promise<Curated[]> {
  const settled = await Promise.allSettled(files.map(({ path, lang, spec }) => toCurated(path, lang, resolve(spec))));
  const failed = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (failed.length === 1) throw failed[0];
  if (failed.length > 1) throw new AggregateError(failed, `${failed.length} files are invalid: ${failed.map(describeError).join("; ")}`);
  const texts = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const seen = new Map<DocumentId, string>();
  for (const text of texts) {
    const other = seen.get(text.id);
    if (other !== undefined) throw new Error(`${text.path}: the same text as ${other}`);
    seen.set(text.id, text.path);
  }
  return texts;
}

/** The changes that make the curated user's documents, and the annotations on those already
 * imported (by document), match the texts: a graph, each change after those it needs. */
export function plan(
  texts: readonly Curated[],
  mine: readonly DocumentSummary[],
  annotations: ReadonlyMap<DocumentId, readonly Annotation[]>,
): Graph<Change> {
  const graph = new GraphBuilder<Change>();
  const byId = new Map(mine.map((d) => [d.id, d]));
  for (const text of texts) planText(graph, text, byId.get(text.id), annotations.get(text.id) ?? []);
  const wanted = new Set(texts.map((t) => t.id));
  for (const document of mine) if (!wanted.has(document.id)) graph.add({ kind: "delete", document });
  return graph.build();
}

/** A text's changes: its import or update, the annotations it has that its file hasn't, and
 * those its file has that it hasn't, in batches. A batch depends on the import, and on the
 * removals, which make room under MAX_ANNOTATIONS. */
function planText(graph: GraphBuilder<Change>, text: Curated, document: DocumentSummary | undefined, had: readonly Annotation[]): void {
  const imported = document === undefined ? [graph.add({ kind: "import", text })] : [];
  const update = document === undefined ? {} : updateOf(text, document);
  if (Object.keys(update).length > 0) graph.add({ kind: "update", text, id: text.id, update });
  const wanted = new Set(text.annotations.map((a) => a.id));
  const removed = had.filter((a) => !wanted.has(a.id)).map((annotation) => graph.add({ kind: "unannotate", text, annotation }));
  const hadIds = new Set(had.map((a) => a.id));
  const missing = text.annotations.filter((a) => !hadIds.has(a.id));
  for (let i = 0; i < missing.length; i += ANNOTATION_BATCH) {
    graph.add({ kind: "annotate", text, annotations: missing.slice(i, i + ANNOTATION_BATCH) }, [...imported, ...removed]);
  }
}

/** What of the document's title and credits differs from the text's file. */
function updateOf(text: Curated, document: DocumentSummary): DocumentUpdate {
  const { title, licence, author, source, tags } = text.request;
  return {
    ...(title !== undefined && title !== document.title ? { title } : {}),
    ...(licence !== document.licence ? { licence } : {}),
    ...((author ?? null) !== document.author ? { author: author ?? null } : {}),
    ...((source ?? null) !== document.source ? { source: source ?? null } : {}),
    ...(sameTags(tags, document.tags) ? {} : { tags }),
  };
}

function sameTags(a: Tags, b: Tags): boolean {
  const kinds = Object.keys(a);
  return kinds.length === Object.keys(b).length && kinds.every((kind) => a[kind] === b[kind]);
}

/** A change's fields for its log record and error */
function describe(change: Change): Readonly<Record<string, unknown>> {
  switch (change.kind) {
    case "import":
      return { change: change.kind, path: change.text.path, doc: change.text.id };
    case "update":
      return { change: change.kind, path: change.text.path, doc: change.id, fields: Object.keys(change.update) };
    case "delete":
      return { change: change.kind, doc: change.document.id, lang: change.document.lang, title: change.document.title };
    case "annotate":
      return { change: change.kind, path: change.text.path, doc: change.text.id, annotations: change.annotations.length };
    case "unannotate":
      return { change: change.kind, path: change.text.path, doc: change.text.id, ...describeAnnotation(change.annotation) };
  }
}

function describeAnnotation({ kind, start, end }: { kind: string; start: number; end: number }) {
  return { annotation: kind, start, end };
}

/** The error for a change the API refused. */
async function refused(response: { status: number; text(): Promise<string> }, change: Change): Promise<Error> {
  return new Error(`${JSON.stringify(describe(change))}: ${response.status} ${await response.text()}`);
}

export type Api = ReturnType<typeof hc<AppType>>["api"];

/** Lists, then unless check is set makes, the changes that make the signed-in user's
 * documents match the texts. */
export async function sync(api: Api, texts: readonly Curated[], { check = false, concurrency = CONCURRENCY } = {}): Promise<Change[]> {
  // Every page: a document missing from the list would be imported again, and one in
  // the list but not in curated/ deleted
  const listStart = performance.now();
  const mine = await allPages(async (after?: Cursor<DocumentKey>) => {
    const listed = await api.me.documents.$get({ query: { after, limit: String(DOCUMENT_PAGE.max) } });
    if (!listed.ok) throw new Error(`list: ${listed.status} ${await listed.text()}`);
    return listed.json();
  });
  log.info("listed {documents} documents", { documents: mine.length, ms: since(listStart) });
  const imported = new Set(mine.map((d) => d.id));
  const annotationsStart = performance.now();
  const annotations = new Map(
    await Promise.all(texts.filter((t) => imported.has(t.id)).map(async (t) => [t.id, await annotationsOf(api, t.id)] as const)),
  );
  log.info("listed the annotations of {documents} documents", {
    documents: annotations.size,
    annotations: [...annotations.values()].reduce((n, a) => n + a.length, 0),
    ms: since(annotationsStart),
  });
  const graph = plan(texts, mine, annotations);
  const changes = [...graph.nodes];
  if (check) {
    for (const change of changes) log.info("to {change}", describe(change));
    return changes;
  }
  await runGraph(graph, concurrency, async (change, signal) => {
    const start = performance.now();
    const made = await make(api, change, { init: { signal } });
    log.info("{change}", { ...describe(change), ...made, ms: since(start) });
  });
  return changes;
}

/** Every page of the signed-in user's annotations on their document. */
function annotationsOf(api: Api, id: DocumentId): Promise<readonly Annotation[]> {
  return allPages(async (after?: Cursor<AnnotationKey>) => {
    const listed = await api.documents[":id"].annotations.$get({ param: { id }, query: { after, limit: String(ANNOTATION_PAGE.max) } });
    if (!listed.ok) throw new Error(`annotations of ${id}: ${listed.status} ${await listed.text()}`);
    return listed.json();
  });
}

/** Makes the change, giving what's worth logging of the response. */
/** options: the client's, for each request, e.g. to abort it */
async function make(api: Api, change: Change, options: ClientRequestOptions): Promise<Readonly<Record<string, unknown>>> {
  switch (change.kind) {
    case "import":
      return made(await api.documents.$post({ json: change.text.request }, options), change);
    case "update":
      return made(await api.documents[":id"].$patch({ param: { id: change.id }, json: change.update }, options), change);
    case "delete":
      return made(await api.documents[":id"].$delete({ param: { id: change.document.id } }, options), change);
    case "unannotate":
      return made(
        await api.documents[":id"].annotations[":annotationId"].$delete(
          {
            param: { id: change.text.id, annotationId: change.annotation.id },
          },
          options,
        ),
        change,
      );
    case "annotate": {
      const response = await api.documents[":id"].annotations.$post(
        {
          param: { id: change.text.id },
          json: { annotations: change.annotations.map((a) => a.request) },
        },
        options,
      );
      if (!response.ok) throw await refused(response, change);
      return { added: (await response.json()).added };
    }
  }
}

/** Nothing to log, once the API has taken the change. */
async function made(
  response: { ok: boolean; status: number; text(): Promise<string> },
  change: Change,
): Promise<Readonly<Record<string, never>>> {
  if (!response.ok) throw await refused(response, change);
  return {};
}

async function main(): Promise<void> {
  const usage = (): never => {
    console.error(
      "usage: SYNC_CURATED_API_KEY=<key> node src/sync-curated.ts <base url> <curated dir> [--check] [--concurrency <n>] [--sample <n>]",
    );
    process.exit(2);
  };
  let args: ReturnType<typeof parseArguments>;
  try {
    args = parseArguments();
  } catch {
    return usage();
  }
  const { check, concurrency: given, sample: sampled } = args.values;
  const [url, dir] = args.positionals;
  const key = process.env["SYNC_CURATED_API_KEY"];
  const concurrency = Number(given ?? CONCURRENCY);
  const sample = sampled === undefined ? undefined : Number(sampled);
  const counts = [concurrency, sample ?? 1];
  if (!url || !dir || !key || args.positionals.length > 2 || !counts.every((n) => Number.isInteger(n) && n >= 1)) return usage();
  const api = hc<AppType>(url.replace(/\/$/u, ""), { headers: { [API_KEY_HEADER]: key } }).api;
  const start = performance.now();
  const files = await readCurated(dir);
  const chosen = sample === undefined ? files : sampleCurated(files, sample);
  if (sample !== undefined)
    log.info("sampled {texts} of {files} texts", { texts: chosen.length, files: files.length, paths: chosen.map((f) => f.path) });
  const texts = await resolveCurated(chosen);
  log.info("resolved {texts} texts", { texts: texts.length, ms: since(start) });
  const changes = await sync(api, texts, { check, concurrency });
  log.info(check ? "{changes} changes to make" : "made {changes} changes", {
    texts: texts.length,
    concurrency,
    changes: changes.length,
    ms: since(start),
  });
  if (check && changes.length > 0) process.exitCode = 1;
}

function parseArguments() {
  return parseArgs({
    allowPositionals: true,
    options: { check: { type: "boolean", default: false }, concurrency: { type: "string" }, sample: { type: "string" } },
  });
}

if (import.meta.main) await runScript(log, main);
