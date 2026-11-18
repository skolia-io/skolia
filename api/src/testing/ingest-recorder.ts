import { DurableObject, WorkerEntrypoint, WorkflowEntrypoint } from "cloudflare:workers";

import { D1IngestHistory } from "@skolia/ingest/history";
import type { IngestJobRecord } from "@skolia/shared/api";

export interface RecorderEnv {
  INGEST_DB: D1Database;
}

/** No container runs in the tests; they give the API their own jobs (testing/app.ts setup) */
export class Ingester extends DurableObject<RecorderEnv> {
  recent(limit: number): Promise<readonly IngestJobRecord[]> {
    return new D1IngestHistory(this.env.INGEST_DB).recent(limit);
  }

  jobs(): null {
    return null;
  }
}

/** The API starts runs of ingest; with no container to hand them to, they end at once */
export class IngestWorkflow extends WorkflowEntrypoint {
  override async run(): Promise<void> {}
}

export default class IngestRecorder extends WorkerEntrypoint {}
