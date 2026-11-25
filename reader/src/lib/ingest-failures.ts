import type { IngestFailure } from "@skolia/shared/schema";

export function describeIngestFailure(failure: IngestFailure | undefined): string {
  if (!failure || typeof failure === "string") return "The analysis failed for an unknown reason.";
  const kind = failure.kind;
  switch (kind) {
    case "unsupported-language":
      return `This language (${failure.lang}) can't be analysed yet.`;
    case "missing-text":
      return "The text wasn't found.";
    case "document-mismatch":
      return "The stored text didn't match this document.";
    case "text-too-long":
      return `The text is too long to analyse (${failure.chars} characters; limit ${failure.limit}).`;
    case "analysis-failed":
      return "The analyser couldn't process this text.";
    case "storage-unavailable":
      return "Storage was temporarily unavailable.";
    case "job-refused":
      return "The analyser couldn't accept this job.";
    case "ingest-no-answer":
      return "The analyser didn't respond.";
    case "status-unavailable":
      return "The analysis status is unavailable.";
    case "unknown":
      return "The analysis failed for an unknown reason.";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
