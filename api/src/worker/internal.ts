// API-owned status publication. No public routes, user Durable Objects or ingest
// bindings: this Worker can deploy before either side of the API/ingest dependency.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { DocumentId } from "@skolia/shared/api";
import type { Status } from "@skolia/shared/schema";
import type { StatusPublisher } from "@skolia/shared/status";
import * as schemas from "@skolia/shared/schemas";
import { publishStatus } from "../controllers/documents.ts";
import { D1Documents } from "./adapters/documents.ts";
import { R2Blobs } from "./adapters/blobs.ts";

interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
}

/** Ingest can publish status, but cannot query the user database. The workflow
 * retries if either store fails; the blob remains the detail endpoint's source. */
export class DocumentStatus extends WorkerEntrypoint<Env> implements StatusPublisher {
  async publish(id: DocumentId, status: Status): Promise<void> {
    await publishStatus(
      {
        blobs: new R2Blobs(this.env.BLOBS),
        documents: new D1Documents(this.env.DB.withSession("first-primary")),
      },
      schemas.DocumentId.parse(id),
      schemas.Status.parse(status),
    );
  }
}

export default {} satisfies ExportedHandler<Env>;
