// An entry's annotations: what its user attached to ranges of its text (lib/ts/annotations.ts),
// seen by whoever sees the entry.
import type * as z from "zod";
import {
  MAX_ANNOTATIONS,
  timestamp,
  type Annotated,
  type Annotation,
  type AnnotationFilter,
  type AnnotationId,
  type AnnotationKey,
  type DocumentId,
  type Paginated,
  type Identity,
} from "@skolia/shared/api";
import { annotationId } from "@skolia/shared/annotations";
import { textKey } from "@skolia/shared/keys";
import type { PageRequest } from "@skolia/shared/page";
import type * as schemas from "@skolia/shared/schemas";
import type { BlobStore } from "../ports/blobs.ts";
import type { Clock } from "../ports/index.ts";
import type { DocumentAnnotations, DocumentLookup, StoredDocument } from "../ports/documents.ts";
import { findDocument, noSuchDocument } from "./documents.ts";
import { NO_CONTENT, fail, ok, type Failed, type NoContent, type Ok } from "./result.ts";

type AnnotationDeps = { documents: DocumentAnnotations & DocumentLookup };

/** A page of the annotations of the entry the viewer sees for the text, so they go with the
 * title and credit shown, that the filter keeps. */
export async function list(
  deps: AnnotationDeps,
  id: string,
  viewer: Identity | null,
  filter: AnnotationFilter,
  page: PageRequest<AnnotationKey>,
): Promise<Ok<Paginated<Annotation, AnnotationKey>> | Failed<404>> {
  const record = await findDocument(deps, id, viewer);
  if (!record) return noSuchDocument();
  return ok(await deps.documents.annotations(record.id, record.user, filter, page));
}

/** The annotations on the user's own entry, those it hasn't already added, in one go. */
export async function add(
  deps: AnnotationDeps & Clock & { blobs: BlobStore },
  user: Identity,
  id: string,
  body: z.output<typeof schemas.NewAnnotations>,
): Promise<Ok<Annotated> | Failed<400 | 404 | 409>> {
  const record = await ownEntry(deps, id, user);
  if (!record) return noEntry();
  const length = await textLength(deps, record.id);
  const after = body.annotations.findIndex((a) => a.end > length);
  if (after >= 0) return fail(400, { code: "annotation-out-of-range", index: after, end: body.annotations[after]!.end, length });
  const addedAt = timestamp(deps.now());
  const annotated = await deps.documents.annotate(
    record.id,
    user.id,
    await Promise.all(body.annotations.map(async (a) => ({ ...a, id: await annotationId(a), addedAt }))),
  );
  switch (annotated.kind) {
    case "added":
      return ok({ added: annotated.added, annotations: [...annotated.annotations] });
    case "full":
      return fail(409, { code: "limit-exceeded", resource: "annotations", limit: MAX_ANNOTATIONS });
  }
}

export async function remove(deps: AnnotationDeps, user: Identity, id: string, annotation: AnnotationId): Promise<NoContent | Failed<404>> {
  const record = await ownEntry(deps, id, user);
  if (!record) return noEntry();
  return (await deps.documents.unannotate(record.id, user.id, annotation)) ? NO_CONTENT : fail(404, { code: "annotation-not-found" });
}

/** The text's length in UTF-16 code units, where its annotations end at most. */
async function textLength(deps: { blobs: BlobStore }, id: DocumentId): Promise<number> {
  const text = await deps.blobs.get(textKey(id));
  if (!text) throw new Error(`document ${id} has no text`);
  return new TextDecoder().decode(text.body).length;
}

/** The user's own entry for the text: the entry they see, if it's theirs. */
async function ownEntry(deps: { documents: DocumentLookup }, id: string, user: Identity): Promise<StoredDocument | null> {
  const record = await findDocument(deps, id, user);
  return record?.user === user.id ? record : null;
}

function noEntry(): Failed<404> {
  return fail(404, { code: "document-not-imported" });
}
