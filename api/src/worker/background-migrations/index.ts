import type { BackgroundMigration } from "./runner.ts";

/** Append only. Versions and names remain stable after deployment. */
export const BACKGROUND_MIGRATIONS: readonly BackgroundMigration[] = [];
