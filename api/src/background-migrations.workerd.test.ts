import assert from "node:assert/strict";
import { test } from "node:test";
import { runBackgroundMigrations, type BackgroundMigration, type Context } from "./worker/background-migrations/runner.ts";
import { R2Blobs } from "./worker/adapters/blobs.ts";
import { local, setup, useLocal } from "./testing/app.ts";

useLocal();

function context(): Context {
  return { db: local.env.DB.withSession("first-primary"), blobs: new R2Blobs(local.env.BLOBS) };
}

const script: BackgroundMigration = {
  version: 1,
  name: "test-batches",
  async run({ blobs }, cursor) {
    await blobs.put(`batch/${cursor ?? "first"}`, "data", "text/plain");
    return { cursor: "second", done: cursor === "second" };
  },
};

async function checkpoint() {
  return local.env.DB.prepare("SELECT cursor, completed_at FROM background_migration WHERE version = 1").first();
}

test("background data migrations checkpoint batches, resume and stay completed", async () => {
  setup();
  await runBackgroundMigrations(context(), [script]);
  assert.deepEqual(await checkpoint(), { cursor: "second", completed_at: null });
  assert.ok(await local.env.BLOBS.head("batch/first"));
  assert.equal(await local.env.BLOBS.head("batch/second"), null);
  await runBackgroundMigrations(context(), [script]);
  assert.ok(await local.env.BLOBS.head("batch/second"));
  const completed = await checkpoint();
  assert.ok(completed?.["completed_at"]);
  await local.env.BLOBS.delete("batch/second");
  await runBackgroundMigrations(context(), [script]);
  assert.equal(await local.env.BLOBS.head("batch/second"), null);
  assert.deepEqual(await checkpoint(), completed);
});

test("a failed batch leaves its cursor unchanged and can retry", async () => {
  setup();
  await assert.rejects(
    runBackgroundMigrations(context(), [
      {
        ...script,
        async run(context, cursor) {
          await script.run(context, cursor);
          throw new Error("stopped before checkpoint");
        },
      },
    ]),
    /stopped before checkpoint/u,
  );
  assert.deepEqual(await checkpoint(), { cursor: null, completed_at: null });
  assert.ok(await local.env.BLOBS.head("batch/first"));
  await runBackgroundMigrations(context(), [script]);
  assert.deepEqual(await checkpoint(), { cursor: "second", completed_at: null });
});

test("an active lease excludes another runner and an expired lease can be resumed", async () => {
  setup();
  await local.env.DB.prepare(`INSERT INTO background_migration
    (version, name, lease_token, lease_expires_at, started_at, updated_at)
    VALUES (1, ?, 'other-worker', '2026-11-04T00:05:00.000Z', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')`)
    .bind(script.name)
    .run();
  await runBackgroundMigrations(context(), [script], new Date("2026-11-04T00:01:00.000Z"));
  assert.equal(await local.env.BLOBS.head("batch/first"), null);
  await runBackgroundMigrations(context(), [script], new Date("2026-11-04T00:06:00.000Z"));
  assert.ok(await local.env.BLOBS.head("batch/first"));
});
