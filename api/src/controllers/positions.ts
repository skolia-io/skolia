import type { Err, setPositionErrors } from "../endpoint-errors.ts";
// Where each user was in each text they've read, in their own Durable Object.
import { timestamp, type DocumentId, type ReadingPosition, type Identity } from "@skolia/shared/api";
import type { Clock } from "../ports/index.ts";
import type { DocumentLookup } from "../ports/documents.ts";
import type { ReadingPositions, StoredPosition } from "../ports/users.ts";
import { MAX_CLOCK_SKEW_MS } from "./cards.ts";
import { NO_CONTENT, fail, ok, type NoContent, type Ok } from "./result.ts";

export async function get(
  deps: { users: ReadingPositions },
  user: Identity,
  id: DocumentId,
): Promise<Ok<{ position: StoredPosition | null }>> {
  return ok({ position: await deps.users.position(user.id, id) });
}

/** A position older than the stored one is ignored, so a late write from another tab
 * can't move the reader back. */
export async function set(
  deps: { users: ReadingPositions; documents: DocumentLookup } & Clock,
  user: Identity,
  id: DocumentId,
  { sentence, token, at }: ReadingPosition,
): Promise<NoContent | Err<typeof setPositionErrors, 400 | 404>> {
  if (Date.parse(at) > deps.now().getTime() + MAX_CLOCK_SKEW_MS) return fail(400, { code: "future-position" });
  if (!(await deps.documents.visible(id, user.id))) return fail(404, { code: "document-not-found" });
  await deps.users.setPosition(user.id, id, { sentence, token, at: timestamp(new Date(at)) });
  return NO_CONTENT;
}
