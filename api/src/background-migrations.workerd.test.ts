import assert from "node:assert/strict";
import { test } from "node:test";
import { docId, statusKey } from "@skolia/shared/keys";
import { BACKGROUND_MIGRATIONS } from "./worker/background-migrations/index.ts";
import { documentStatus } from "./worker/background-migrations/0001-document-status.ts";
import { runBackgroundMigrations, type Context } from "./worker/background-migrations/runner.ts";
import { D1Documents, R2Blobs } from "./worker/adapters.ts";
import { local, setup, useLocal } from "./testing/app.ts";

useLocal();

function context(): Context {
  return { db: local.env.DB.withSession("first-primary"), blobs: new R2Blobs(local.env.BLOBS) };
}

async function legacy(n: number) {
  const id = await docId("pl", `legacy document ${n}`);
  await local.env.DB.prepare("INSERT INTO document (id, lang, words) VALUES (?, 'pl', 3)").bind(id).run();
  await new R2Blobs(local.env.BLOBS).put(
    statusKey(id),
    JSON.stringify({
      state: "ready",
      updated: "2026-11-04T00:00:00.000Z",
      analyzer: "a",
      lexicon: "l",
      analysis: "analysis",
      bundle: "bundle",
    }),
    "application/json",
  );
  return id;
}

test("background data migrations checkpoint bounded batches, resume and stay completed", async () => {
  setup();
  const ids = await Promise.all(Array.from({ length: 26 }, (_, n) => legacy(n)));
  const db = local.env.DB;
  await runBackgroundMigrations(context(), BACKGROUND_MIGRATIONS);
  const first = await db.prepare("SELECT cursor, completed_at FROM background_migration WHERE version = 1").first();
  assert.deepEqual(first, { cursor: [...ids].sort()[23], completed_at: null });
  assert.equal((await db.prepare("SELECT count(*) AS n FROM document_status").first())?.["n"], 24);
  await runBackgroundMigrations(context(), BACKGROUND_MIGRATIONS);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM document_status").first())?.["n"], 26);
  const completed = await db.prepare("SELECT * FROM background_migration WHERE version = 1").first();
  assert.ok(completed?.["completed_at"]);
  // Even a later legacy row cannot cause a completed version to run again.
  await legacy(99);
  await runBackgroundMigrations(context(), BACKGROUND_MIGRATIONS);
  assert.deepEqual(await db.prepare("SELECT * FROM background_migration WHERE version = 1").first(), completed);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM document_status").first())?.["n"], 26);
});

test("replaying a batch preserves live publications and projects absent and malformed blobs as no status", async () => {
  setup();
  const [ready, absent, malformed] = await Promise.all([legacy(1), legacy(2), legacy(3)]);
  await local.env.BLOBS.delete(statusKey(absent));
  await new R2Blobs(local.env.BLOBS).put(statusKey(malformed), "not json", "application/json");
  // Simulate losing a Worker after its data writes but before its checkpoint.
  await documentStatus.run(context(), null);
  const published = { state: "failed" as const, updated: "2026-11-04T01:00:00.000Z", error: "newer publication" };
  await new D1Documents(context().db).setStatus(ready, published);
  await runBackgroundMigrations(context(), BACKGROUND_MIGRATIONS);
  const rows = await local.env.DB.prepare("SELECT document_id, status FROM document_status ORDER BY document_id").all();
  assert.deepEqual(
    new Map(rows.results.map((row) => [row["document_id"], JSON.parse(String(row["status"])) as unknown])),
    new Map([
      [ready, published],
      [absent, null],
      [malformed, null],
    ]),
  );
});

test("a failed batch keeps its checkpoint and retries its data writes safely", async () => {
  setup();
  await legacy(1);
  await assert.rejects(
    runBackgroundMigrations(context(), [
      {
        ...documentStatus,
        run: async (context, cursor) => {
          await documentStatus.run(context, cursor);
          throw new Error("stopped before checkpoint");
        },
      },
    ]),
    /stopped before checkpoint/u,
  );
  assert.deepEqual(await local.env.DB.prepare("SELECT cursor, completed_at FROM background_migration WHERE version = 1").first(), {
    cursor: null,
    completed_at: null,
  });
  await runBackgroundMigrations(context(), BACKGROUND_MIGRATIONS);
  assert.ok((await local.env.DB.prepare("SELECT completed_at FROM background_migration WHERE version = 1").first())?.["completed_at"]);
});

test("an active lease excludes another runner and an expired lease can be resumed", async () => {
  setup();
  const id = await legacy(1);
  await local.env.DB.prepare(`INSERT INTO background_migration
    (version, name, lease_token, lease_expires_at, started_at, updated_at)
    VALUES (1, 'document-status', 'other-worker', '2026-11-04T00:05:00.000Z', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')`).run();
  await runBackgroundMigrations(context(), BACKGROUND_MIGRATIONS, new Date("2026-11-04T00:01:00.000Z"));
  assert.equal(await local.env.DB.prepare("SELECT status FROM document_status WHERE document_id = ?").bind(id).first(), null);
  await runBackgroundMigrations(context(), BACKGROUND_MIGRATIONS, new Date("2026-11-04T00:06:00.000Z"));
  assert.ok(await local.env.DB.prepare("SELECT status FROM document_status WHERE document_id = ?").bind(id).first());
});
