import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import { D1IngestHistory } from "@skolia/ingest/history";
import type { IngestJobRecord } from "@skolia/shared/api";

export interface RecorderEnv {
  INGEST_DB: D1Database;
}

const received: unknown[] = [];

/** No container runs in the tests; they give the API their own jobs (testing/app.ts setup) */
export class Ingester extends DurableObject<RecorderEnv> {
  recent(limit: number): Promise<readonly IngestJobRecord[]> {
    return new D1IngestHistory(this.env.INGEST_DB).recent(limit);
  }

  jobs(): null {
    return null;
  }
}

export default class IngestRecorder extends WorkerEntrypoint {
  override async queue(batch: MessageBatch): Promise<void> {
    for (const message of batch.messages) received.push(message.body);
    batch.ackAll();
  }

  received(): unknown[] {
    return received;
  }

  clear(): void {
    received.length = 0;
  }
}
