import { documentStatus } from "./0001-document-status.ts";
import type { BackgroundMigration } from "./runner.ts";

/** Append only. Versions and names remain stable after deployment. */
export const BACKGROUND_MIGRATIONS: readonly BackgroundMigration[] = [documentStatus];
