import type { IngestFailure } from "@skolia/shared/schema";

const MESSAGES = {
  "unsupported-language": "This language can't be analysed yet.",
  "missing-text": "The text wasn't found.",
  "document-mismatch": "The stored text didn't match this document.",
  "text-too-long": "The text is too long to analyse.",
  "analysis-failed": "The analyser couldn't process this text.",
  "storage-unavailable": "Storage was temporarily unavailable.",
  "job-refused": "The analyser couldn't accept this job.",
  "ingest-no-answer": "The analyser didn't respond.",
  "status-unavailable": "The analysis status is unavailable.",
  unknown: "The analysis failed for an unknown reason.",
} as const satisfies Record<IngestFailure, string>;

export function describeIngestFailure(code: IngestFailure | undefined): string {
  return code && Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : MESSAGES.unknown;
}
