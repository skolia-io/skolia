import type { DocumentId } from "./api.ts";
import type { Status } from "./schema.gen.ts";

/** The API's internal status publication boundary, callable only by service binding. */
export interface StatusPublisher {
  publish(id: DocumentId, status: Status): Promise<void>;
}
