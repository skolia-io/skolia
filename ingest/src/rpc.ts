// What the API calls on the Ingester it binds (INGESTER, script_name skolia-ingest), and what it
// starts a run of its workflow with (INGEST_WORKFLOW), apart from main.ts so the API's types
// don't take in the ingest Worker's
import type { ContainerJobs, DocumentId, IngestHistory, Lang } from "@skolia/shared/api";

/** A run of ingest (workflow.ts IngestWorkflow) is for one document */
export type IngestParams = {
  readonly doc: DocumentId;
  readonly lang: Lang;
};

export type IngesterRpc = Rpc.DurableObjectBranded &
  IngestHistory & {
    /** The language's container's jobs, or null when none is running */
    jobs(lang: Lang): Promise<ContainerJobs | null>;
  };
