import type { ApiError } from "@skolia/shared/api";

type Failure = ApiError["error"];

const RESOURCE = {
  "text-characters": "characters in a text",
  "annotation-bytes": "bytes in an annotation batch",
  annotations: "annotations per entry",
  cards: "cards per user",
  "reading-lists": "reading lists per user",
} as const;

const MESSAGE = {
  "internal-error": "Something went wrong on the server.",
  "lexicon-version-changed": "The lexicon has changed. Fetch the current version and try again.",
  "lexicon-unavailable": "The lexicon is unavailable.",
  "request-rejected": "The server rejected this request.",
  "invalid-json": "The request body isn't valid JSON.",
  "sign-in-required": "Please sign in first.",
  "sign-in-unavailable": "Sign-in is unavailable.",
  "document-not-found": "No such document.",
  "annotation-not-found": "No such annotation.",
  "card-not-found": "No such card.",
  "word-not-found": "No such word.",
  "reading-list-not-found": "No such reading list.",
  "not-document-importer": "Only the person who imported this text can change it.",
  "sharing-license-required": "A public text needs a licence that allows sharing it.",
  "document-not-imported": "You haven't imported this text.",
  "future-position": "The reading position is dated in the future.",
  "future-review": "The review is dated in the future.",
  "review-too-old": "This review is older than the card or its last review.",
  "review-id-conflict": "That review ID belongs to another card.",
} as const;

export function describeApiError(error: Failure): string {
  switch (error.code) {
    case "invalid-request":
      return error.path.length ? `Check the value for ${error.path.join(".")}.` : "Check the request and try again.";
    case "limit-exceeded":
      return `The limit is ${error.limit} ${RESOURCE[error.resource]}.`;
    case "unknown-tag":
      return `No such tag: ${error.tag}.`;
    case "entry-not-found":
      return `No lexicon entry for ${error.entry}.`;
    case "analysis-not-found":
      return `No such analysis: ${error.name}.`;
    case "encoding-required":
      return `This response requires ${error.encoding} support.`;
    case "annotation-out-of-range":
      return `Annotation ${error.index + 1} extends past the end of the text.`;
    case "rate-limited":
      return `Too many imports. Try again in ${error.retryAfterSeconds} seconds.`;
    default:
      return MESSAGE[error.code];
  }
}
