import type { DocumentId } from "./api.ts";
import type { Status } from "./schema.gen.ts";

/** The API's internal status publication boundary, callable only by service binding. */
export interface StatusPublisher {
  publish(id: DocumentId, status: Status): Promise<void>;
}

/** Retain the original key for Workers on an older version during rollout or rollback. */
export function compatibleStatus(status: Status): Status & { readonly updated: string } {
  return { ...status, updated: status.updatedAt };
}
