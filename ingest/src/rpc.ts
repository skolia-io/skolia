// What the API calls on the Ingester it binds (INGESTER, script_name skolia-ingest), apart
// from main.ts so the API's types don't take in the ingest Worker's
import type { ContainerJobs, IngestJobRecord, Lang } from "@skolia/shared/api";

export type IngesterRpc = Rpc.DurableObjectBranded & {
  /** The language's container's jobs, or null when none is running */
  jobs(lang: Lang): Promise<ContainerJobs | null>;
  recent(limit: number): Promise<readonly IngestJobRecord[]>;
};
