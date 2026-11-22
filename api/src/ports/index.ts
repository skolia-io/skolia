import type { IngestHistory, ReaderConfig } from "@skolia/shared/api";
import type { Auth } from "./auth.ts";
import type { BlobStore } from "./blobs.ts";
import type { DocumentStore } from "./documents.ts";
import type { JobQueue } from "./ingest.ts";
import type { Lexicon } from "./lexicon.ts";
import type { Permissions } from "./permissions.ts";
import type { UserData } from "./users.ts";
import type { RateLimit } from "../rate-limits.ts";

export interface Clock {
  now: () => Date;
}

export interface Deps extends Clock {
  auth: Auth;
  users: UserData;
  lexicon: Lexicon;
  documents: DocumentStore;
  blobs: BlobStore;
  queue: JobQueue;
  ingestHistory: IngestHistory;
  /** What roles let their users do */
  permissions: Permissions;
  /** How many imports a user may make in a window, unless their role grants unlimited-rate (rate-limits.ts) */
  importRate: RateLimit;
  /** git describe of the build */
  version: string;
  /** What the reader is set to do in this deployment (reader-config.ts) */
  reader: ReaderConfig;
  /** For the tests: a response its route's spec doesn't describe is a 500 (openapi.ts). */
  checkResponses?: boolean;
}
