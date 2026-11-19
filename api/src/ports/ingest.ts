import type { DocumentId, Lang, ContainerJobs } from "@skolia/shared/api";
import type { Versions } from "@skolia/shared/schema";

/** A language's ingest container's jobs (analysis/src/skolia_analysis/ingest/http.py
 * JobsState) */
export type IngestJobs = ContainerJobs;

export interface JobQueue {
  /** Starts a run of ingest for the document, made to the versions ingest now publishes (null
   * before it has published any). One under way is left to finish; one that has ended is run
   * again. */
  start(doc: DocumentId, lang: Lang, versions: Versions | null): Promise<void>;
  /** Null when no container is running for the language, or it can't be asked. */
  jobs(lang: Lang): Promise<IngestJobs | null>;
}
