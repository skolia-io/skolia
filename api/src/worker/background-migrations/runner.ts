import * as z from "zod";
import { sql } from "@skolia/util/sql";
import { log } from "@skolia/util/log";
import { prepare } from "../adapters.ts";

const logger = log("background-migrations");
const LEASE_MS = 5 * 60 * 1000;
const Row = z.object({ name: z.string(), cursor: z.string().nullable(), completedAt: z.string().nullable() });
const Claimed = Row.pick({ cursor: true });

export interface Context {
  readonly db: D1DatabaseSession;
  readonly bucket: R2Bucket;
}

export interface BackgroundMigration {
  readonly version: number;
  readonly name: string;
  /** One bounded, idempotent batch. Data writes precede the checkpoint, so a batch
   * can replay after a crash or an expired lease. Never change the schema here. */
  readonly run: (context: Context, cursor: string | null) => Promise<{ readonly cursor: string | null; readonly done: boolean }>;
}

/** Run one batch of the first unfinished script. Cron drives progress independently
 * of traffic and deploys. A lease excludes overlapping ticks, but scripts must still
 * tolerate replay: a Worker can stop after writing data and before checkpointing. */
export async function runBackgroundMigrations(
  context: Context,
  migrations: readonly BackgroundMigration[],
  now = new Date(),
): Promise<void> {
  if (!migrations.every((migration, index) => migration.version === index + 1)) {
    throw new Error("background migrations must be ordered, contiguous versions starting at 1");
  }
  const { db } = context;
  for (const migration of migrations) {
    const { version, name } = migration;
    const raw = await prepare(
      db,
      sql`SELECT name, cursor, completed_at AS completedAt FROM background_migration WHERE version = ${version}`,
    ).first();
    const row = raw === null ? null : Row.parse(raw);
    if (row !== null && row.name !== name) throw new Error(`background migration ${version} was renamed`);
    if (row?.completedAt !== null && row?.completedAt !== undefined) continue;
    const token = crypto.randomUUID();
    const at = now.toISOString();
    const expires = new Date(now.getTime() + LEASE_MS).toISOString();
    const claimed = await prepare(
      db,
      sql`INSERT INTO background_migration
      (version, name, lease_token, lease_expires_at, started_at, updated_at)
      VALUES (${version}, ${name}, ${token}, ${expires}, ${at}, ${at})
      ON CONFLICT (version) DO UPDATE SET lease_token = excluded.lease_token,
        lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at
      WHERE background_migration.completed_at IS NULL AND background_migration.lease_expires_at <= ${at}
        AND background_migration.name = ${name}
      RETURNING cursor`,
    ).first();
    if (claimed === null) return;
    const { cursor } = Claimed.parse(claimed);
    try {
      const next = await migration.run(context, cursor);
      const updated = new Date().toISOString();
      await prepare(
        db,
        sql`UPDATE background_migration SET cursor = ${next.cursor}, updated_at = ${updated},
        lease_expires_at = ${updated}, completed_at = ${next.done ? updated : null}
        WHERE version = ${version} AND lease_token = ${token}`,
      ).run();
      logger.info("ran background migration batch", { version, name, cursor: next.cursor, done: next.done });
    } catch (error) {
      // Don't advance the cursor. The next tick retries the same batch.
      await prepare(
        db,
        sql`UPDATE background_migration SET lease_expires_at = ${new Date().toISOString()}
        WHERE version = ${version} AND lease_token = ${token}`,
      ).run();
      logger.error("background migration batch failed", { version, name, cursor, error });
      throw error;
    }
    return;
  }
}
