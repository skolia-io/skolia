import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import { D1IngestHistory } from "@skolia/ingest/history";
import type { IngestJobRecord } from "@skolia/shared/api";
import { statusKey } from "@skolia/shared/keys";
import { DocumentId } from "@skolia/shared/schemas";
import type { IngestJob, Status } from "@skolia/shared/schema";

export interface RecorderEnv {
  INGEST_DB: D1Database;
  BLOBS: R2Bucket;
}

const received: IngestJob[] = [];

/** No container runs in the tests; they give the API their own jobs (testing/app.ts setup) */
export class Ingester extends DurableObject<RecorderEnv> {
  recent(limit: number): Promise<readonly IngestJobRecord[]> {
    return new D1IngestHistory(this.env.INGEST_DB).recent(limit);
  }

  async enqueue(job: IngestJob, queued: Status): Promise<void> {
    await this.env.BLOBS.put(statusKey(DocumentId.parse(job.doc)), JSON.stringify(queued));
    received.push(job);
  }

  jobs(): null {
    return null;
  }
}

export default class IngestRecorder extends WorkerEntrypoint {
  received(): IngestJob[] {
    return received;
  }

  clear(): void {
    received.length = 0;
  }
}
