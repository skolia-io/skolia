import type { ContentfulStatusCode } from "hono/utils/http-status";
import { apiError, limitExceeded } from "@skolia/shared/schemas";
import { json } from "@skolia/util/openapi";
import type * as z from "zod";

function error<const V extends Parameters<typeof apiError>[0]>(description: string, first: V, ...others: readonly V[]) {
  return json(apiError(first, ...others), description);
}

const SignInRequired = apiError("sign-in-required").meta({ id: "SignInRequired" });
export const NOT_SIGNED_IN = json(SignInRequired, "Not signed in");
const INVALID_REQUEST = error("The request doesn't fit its schema", "invalid-request");
export const INVALID_JSON_REQUEST = json(
  apiError("invalid-json", "invalid-request").meta({ id: "InvalidJsonRequest" }),
  "Invalid JSON or a request that doesn't fit its schema",
);
const NO_DOCUMENT = json(apiError("document-not-found").meta({ id: "DocumentNotFound" }), "No such document");
const NO_LIST = json(apiError("reading-list-not-found").meta({ id: "ReadingListNotFound" }), "No such list");
const NO_CARD = json(apiError("card-not-found").meta({ id: "CardNotFound" }), "No such card");
const NOT_IMPORTER = error("Not the user's entry", "not-document-importer");
const AUTH = { 401: NOT_SIGNED_IN } as const;
const JSON_AUTH = { 400: INVALID_JSON_REQUEST, ...AUTH } as const;

export const reviewErrors = {
  ...AUTH,
  400: error("Invalid request or a review in the future", "invalid-request", "invalid-json", "future-review"),
  404: NO_CARD,
  409: error("Conflicting review id or a review older than the last one", "review-id-conflict", "review-too-old"),
};
export const makeCardErrors = { ...JSON_AUTH, 404: NO_DOCUMENT, 409: error("Card limit reached", limitExceeded("cards")) };
export const setWordStateErrors = { ...JSON_AUTH, 404: error("The user hasn't the word", "word-not-found") };
export const deleteCardErrors = { 400: INVALID_REQUEST, ...AUTH, 404: NO_CARD };
export const setPositionErrors = {
  ...AUTH,
  400: error("Invalid request or a position in the future", "invalid-request", "invalid-json", "future-position"),
  404: NO_DOCUMENT,
};
export const createReadingListErrors = { ...JSON_AUTH, 409: error("List limit reached", limitExceeded("reading-lists")) };
export const renameReadingListErrors = { ...JSON_AUTH, 404: NO_LIST };
export const readingListErrors = { 400: INVALID_REQUEST, ...AUTH, 404: NO_LIST };
export const addToReadingListErrors = {
  400: INVALID_REQUEST,
  ...AUTH,
  404: error("No such list or document", "reading-list-not-found", "document-not-found"),
};
export const listDocumentsErrors = { 400: INVALID_REQUEST, 401: json(SignInRequired, "mine=true without a session") };
export const importDocumentErrors = {
  ...AUTH,
  400: error("Invalid request or unknown tag", "invalid-request", "invalid-json", "unknown-tag"),
  413: error("The text is too long", limitExceeded("text-characters")),
  429: error("Import rate limit reached", "rate-limited"),
};
export const documentErrors = { 404: NO_DOCUMENT };
export const listAnnotationsErrors = { 400: INVALID_REQUEST, ...documentErrors };
export const updateDocumentErrors = {
  ...AUTH,
  400: error("Invalid request or disallowed change", "invalid-request", "invalid-json", "unknown-tag", "sharing-license-required"),
  403: NOT_IMPORTER,
  404: NO_DOCUMENT,
};
export const deleteDocumentErrors = { ...AUTH, 403: NOT_IMPORTER, 404: NO_DOCUMENT };
export const documentTextErrors = { ...documentErrors, 500: error("The text could not be loaded", "internal-error") };
export const documentAnalysisErrors = {
  404: error("No such document or analysis", "document-not-found", "analysis-not-found"),
  406: error("The client doesn't accept Brotli", "encoding-required"),
};
export const addAnnotationsErrors = {
  ...AUTH,
  400: error("Invalid request or an annotation ends after the text", "invalid-request", "invalid-json", "annotation-out-of-range"),
  404: error("The user hasn't imported the text", "document-not-imported"),
  409: error("Annotation limit reached", limitExceeded("annotations")),
  413: error("The annotations are too big", limitExceeded("annotation-bytes")),
};
export const deleteAnnotationErrors = {
  400: INVALID_REQUEST,
  ...AUTH,
  404: error("The user hasn't imported the text, or it has no such annotation", "document-not-imported", "annotation-not-found"),
};

/** A controller's failure, retaining the pairing between status and body. */
export type EndpointFailure<Contract, Status extends keyof Contract & ContentfulStatusCode = keyof Contract & ContentfulStatusCode> = {
  [S in Status]: Contract[S] extends { schema: infer Schema extends z.ZodType }
    ? { status: S; body: z.output<Schema>; headers?: Readonly<Record<string, string>> }
    : never;
}[Status];

type EndpointError<Contract> = EndpointFailure<Contract>["body"];

export type ReviewError = EndpointError<typeof reviewErrors>;
export type MakeCardError = EndpointError<typeof makeCardErrors>;
export type SetWordStateError = EndpointError<typeof setWordStateErrors>;
export type DeleteCardError = EndpointError<typeof deleteCardErrors>;
export type SetPositionError = EndpointError<typeof setPositionErrors>;
export type CreateReadingListError = EndpointError<typeof createReadingListErrors>;
export type RenameReadingListError = EndpointError<typeof renameReadingListErrors>;
export type ReadingListError = EndpointError<typeof readingListErrors>;
export type AddToReadingListError = EndpointError<typeof addToReadingListErrors>;
export type ListDocumentsError = EndpointError<typeof listDocumentsErrors>;
export type ImportDocumentError = EndpointError<typeof importDocumentErrors>;
export type DocumentError = EndpointError<typeof documentErrors>;
export type UpdateDocumentError = EndpointError<typeof updateDocumentErrors>;
export type DeleteDocumentError = EndpointError<typeof deleteDocumentErrors>;
export type DocumentTextError = EndpointError<typeof documentTextErrors>;
export type DocumentAnalysisError = EndpointError<typeof documentAnalysisErrors>;
export type ListAnnotationsError = EndpointError<typeof listAnnotationsErrors>;
export type AddAnnotationsError = EndpointError<typeof addAnnotationsErrors>;
export type DeleteAnnotationError = EndpointError<typeof deleteAnnotationErrors>;
