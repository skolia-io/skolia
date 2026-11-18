import type { DocumentId } from "./api.ts";
import type { Status } from "./schema.gen.ts";

/** Keep the existing flat wire format during rolling deploys: older readers don't
 * understand nested artifacts. Application code uses the discriminated union. */
export function statusForStorage({ artifacts, ...status }: Status) {
  return { ...status, ...artifacts };
}

/** The API's internal status publication boundary, callable only by service binding. */
export interface StatusPublisher {
  publish(id: DocumentId, status: Status): Promise<void>;
}
