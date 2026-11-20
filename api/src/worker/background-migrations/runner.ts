import * as z from "zod";
import { sql } from "@skolia/util/sql";
import { log } from "@skolia/util/log";
import type { BlobStore } from "../../ports/blobs.ts";
import { prepare } from "@skolia/util/d1";

const logger = log("background-migrations");
const LEASE_MS = 5 * 60 * 1000;
const MAX_BATCHES = 10;
const RUN_BUDGET_MS = 20_000;
const MigrationRow = z.object({ name: z.string(), completedAt: z.string().nullable() });
const Claim = z.object({ cursor: z.string().nullable() });

export interface Context {
  readonly db: D1DatabaseSession;
  readonly blobs: BlobStore;
}

export interface BackgroundMigration {
  readonly version: number;
  readonly name: string;
  /** One bounded, idempotent batch. Data writes precede the checkpoint, so a batch
   * can replay after a crash or an expired lease. Never change the schema here. */
  readonly run: (context: Context, cursor: string | null) => Promise<{ readonly cursor: string | null; readonly done: boolean }>;
}

/** Run bounded batches of the first unfinished script. Cron drives progress independently
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
  const started = performance.now();
  const deadline = started + RUN_BUDGET_MS;
  const { db } = context;
  for (const migration of migrations) {
    const { version, name } = migration;
    const stored = await prepare(
      db,
      sql`SELECT name, completed_at AS completedAt FROM background_migration WHERE version = ${version}`,
    ).first();
    if (stored !== null) {
      const row = MigrationRow.parse(stored);
      if (row.name !== name) throw new Error(`background migration ${version} was renamed`);
      if (row.completedAt !== null) continue;
    }

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
    let { cursor } = Claim.parse(claimed);
    try {
      // Finish the current batch and checkpoint it even if the time budget has elapsed.
      for (let batch = 1; batch <= MAX_BATCHES && performance.now() < deadline; batch += 1) {
        const next = await migration.run(context, cursor);
        const updated = new Date().toISOString();
        const checkpoint = await prepare(
          db,
          sql`UPDATE background_migration SET cursor = ${next.cursor}, updated_at = ${updated},
          completed_at = ${next.done ? updated : null}
          WHERE version = ${version} AND lease_token = ${token}`,
        ).run();
        if (checkpoint.meta.changes !== 1) throw new Error("background migration lease lost");
        cursor = next.cursor;
        logger.info("ran background migration batch", {
          version,
          name,
          batch,
          cursor,
          done: next.done,
          ms: Math.round(performance.now() - started),
          maxBatches: MAX_BATCHES,
          budgetMs: RUN_BUDGET_MS,
        });
        if (next.done) break;
      }
    } catch (error) {
      logger.error("background migration batch failed", { version, name, cursor, error });
      throw error;
    } finally {
      // Release only our lease. After a crash the lease expires and the next tick
      // resumes at the last committed checkpoint.
      await prepare(
        db,
        sql`UPDATE background_migration SET lease_expires_at = ${new Date().toISOString()}
        WHERE version = ${version} AND lease_token = ${token}`,
      ).run();
    }
    return;
  }
}
