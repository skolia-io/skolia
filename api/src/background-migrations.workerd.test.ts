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

test("background migrations checkpoint several batches, resume at the batch limit and stay completed", async () => {
  setup();
  const longScript: BackgroundMigration = {
    ...script,
    async run({ blobs }, cursor) {
      const batch = Number(cursor ?? "0") + 1;
      if (batch === 2) {
        await runBackgroundMigrations(context(), [
          { ...script, run: () => assert.fail("another runner claimed the lease between batches") },
        ]);
      }
      await blobs.put(`batch/${batch}`, "data", "text/plain");
      return { cursor: String(batch), done: batch === 11 };
    },
  };
  await runBackgroundMigrations(context(), [longScript]);
  assert.deepEqual(await checkpoint(), { cursor: "10", completed_at: null });
  assert.ok(await local.env.BLOBS.head("batch/1"));
  assert.ok(await local.env.BLOBS.head("batch/10"));
  assert.equal(await local.env.BLOBS.head("batch/11"), null);
  await runBackgroundMigrations(context(), [longScript]);
  assert.ok(await local.env.BLOBS.head("batch/11"));
  const completed = await checkpoint();
  assert.ok(completed?.["completed_at"]);
  await local.env.BLOBS.delete("batch/11");
  await runBackgroundMigrations(context(), [longScript]);
  assert.equal(await local.env.BLOBS.head("batch/11"), null);
  assert.deepEqual(await checkpoint(), completed);
});

test("a failed batch leaves its cursor unchanged and can retry", async () => {
  setup();
  await assert.rejects(
    runBackgroundMigrations(context(), [
      {
        ...script,
        async run(context, cursor) {
          const next = await script.run(context, cursor);
          if (cursor === "second") throw new Error("stopped before checkpoint");
          return next;
        },
      },
    ]),
    /stopped before checkpoint/u,
  );
  assert.deepEqual(await checkpoint(), { cursor: "second", completed_at: null });
  assert.ok(await local.env.BLOBS.head("batch/first"));
  assert.ok(await local.env.BLOBS.head("batch/second"));
  await local.env.BLOBS.delete("batch/first");
  await runBackgroundMigrations(context(), [script]);
  assert.ok((await checkpoint())?.["completed_at"]);
  assert.equal(await local.env.BLOBS.head("batch/first"), null);
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
