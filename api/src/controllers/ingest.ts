import {
  LANGS,
  type DocumentId,
  type IngestEvent,
  type IngestedDocument,
  type IngestOverview,
  type PastIngestJob,
  type User,
} from "@skolia/shared/api";
import type { Deps, StoredDocument } from "../ports.ts";
import { fail, ok, type Failed, type Json, type Ok } from "./result.ts";

/** How many of the jobs started most recently the overview lists */
export const RECENT_JOBS = 50;

/** What each language's ingest container is doing, and the jobs started most recently,
 * for anyone: a text the viewer can't see is only its language, size and timings. */
export async function overview(deps: Deps, viewer: User | null): Promise<Ok<IngestOverview>> {
  const [live, stored] = await Promise.all([
    Promise.all(LANGS.map((lang) => deps.queue.jobs(lang))),
    deps.ingestHistory.recent(RECENT_JOBS),
  ]);
  const running = new Set(live.flatMap((jobs) => jobs?.jobs.map((job) => job.id) ?? []));
  // A job an analyser is running is shown with it, not again here
  const recent = stored.filter((job) => job.result !== null || !running.has(job.id));
  const ids = [...new Set([...live.flatMap((jobs) => jobs?.jobs.map((job) => job.doc) ?? []), ...recent.map((job) => job.doc)])];
  const visible = await deps.documents.visibleAll(ids, viewer?.id ?? null);
  const document = (id: DocumentId): IngestedDocument => shown(visible.get(id));
  return ok({
    languages: LANGS.map((lang, i) => {
      const jobs = live[i] ?? null;
      return {
        lang,
        container:
          jobs === null
            ? null
            : {
                startedAt: jobs.startedAt ?? null,
                loading: jobs.loading,
                jobs: jobs.jobs.map(({ doc, ...job }) => ({ ...job, document: document(doc) })),
              },
      };
    }),
    recent: recent.map(({ doc, result, ...job }): PastIngestJob => {
      const seen = document(doc);
      return { ...job, document: seen, result: result && { ...result, error: seen === null ? null : result.error } };
    }),
  });
}

function shown(entry: StoredDocument | undefined): IngestedDocument {
  return entry === undefined ? null : { id: entry.id, title: entry.title };
}
