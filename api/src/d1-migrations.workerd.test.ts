import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTestHarness } from "wrangler";
import { insertKeySql } from "./api-keys.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url).pathname;

/** What references "user", directly or through user_document, and must keep its rows: each
 * table, and its column that names the user. */
const OWNERS = {
  session: `"userId"`,
  account: `"userId"`,
  apikey: `"referenceId"`,
  user_document: "user_id",
  user_document_tag: "user_id",
  user_document_annotation: "user_id",
} as const;
const CHILDREN = Object.keys(OWNERS) as (keyof typeof OWNERS)[];

test("0002 moves the system role to bindings and drops user.role, keeping every user and what references them", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "skolia-d1-migrations-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const migrations = join(dir, "migrations");
  await mkdir(migrations);
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  assert.equal(files[0], "0001_initial.sql");
  await copyFile(join(MIGRATIONS, "0001_initial.sql"), join(migrations, "0001_initial.sql"));
  await writeFile(join(dir, "worker.js"), "export default { fetch: () => new Response(null, { status: 404 }) };\n");
  await writeFile(
    join(dir, "wrangler.json"),
    JSON.stringify({
      name: "d1-migrations",
      main: "worker.js",
      compatibility_date: "2026-10-19",
      d1_databases: [{ binding: "DB", database_name: "d1-migrations", migrations_dir: "migrations" }],
    }),
  );
  const server = createTestHarness({ root: dir, workers: [{ configPath: "./wrangler.json" }] });
  await server.listen();
  t.after(() => server.close());
  const worker = server.getWorker<{ DB: D1Database }>();
  await worker.applyD1Migrations("DB");
  const { DB: db } = await worker.getEnv();

  const at = "2026-11-07T00:00:00.000Z";
  const doc = "a".repeat(64);
  await db.batch([
    db
      .prepare(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('ivy', 'Ivy', 'ivy@example.com', 1, ?, ?)`,
      )
      .bind(at, at),
    db
      .prepare(`INSERT INTO session ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId") VALUES ('s', ?, 't', ?, ?, 'ivy')`)
      .bind(at, at, at),
    db
      .prepare(
        `INSERT INTO account ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES ('a', 'g', 'google', 'ivy', ?, ?)`,
      )
      .bind(at, at),
    db.prepare(insertKeySql("ivy-key", "ivy", "0".repeat(64), at)),
    db.prepare(insertKeySql("sync-curated", "curated", "1".repeat(64), at)),
    db.prepare("INSERT INTO document (id, lang, words) VALUES (?, 'pl', 1)").bind(doc),
    db.prepare("INSERT INTO attribution (id, licence) VALUES (1, 'cc0')"),
    db
      .prepare(
        "INSERT INTO user_document (user_id, document_id, title, imported_at, visibility, attribution_id) VALUES ('ivy', ?, 't', ?, 'public', 1)",
      )
      .bind(doc, at),
    db.prepare("INSERT INTO user_document_tag (user_id, document_id, kind, value) VALUES ('ivy', ?, 'level', 'A1')").bind(doc),
    db
      .prepare(
        `INSERT INTO user_document_annotation (user_id, document_id, id, start, "end", kind, data, attribution_id, added_at) VALUES ('ivy', ?, 'x', 0, 1, 'text', '{}', 1, ?)`,
      )
      .bind(doc, at),
  ]);
  const snapshot = async () => ({
    users: (await db.prepare(`SELECT "id", "name", "email", "createdAt" FROM "user" ORDER BY "id"`).all()).results,
    ...Object.fromEntries(
      await Promise.all(CHILDREN.map(async (table) => [table, (await db.prepare(`SELECT * FROM ${table}`).all()).results] as const)),
    ),
  });
  const before = await snapshot();
  assert.equal(before.users.length, 3);

  await Promise.all(files.slice(1).map((f) => copyFile(join(MIGRATIONS, f), join(migrations, f))));
  await worker.applyD1Migrations("DB");

  assert.deepEqual(await snapshot(), before);
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.deepEqual((await db.prepare(`SELECT name FROM pragma_table_info('user') WHERE name = 'role'`).all()).results, []);
  assert.deepEqual((await db.prepare("SELECT name FROM role").all()).results, [{ name: "system" }]);
  assert.deepEqual((await db.prepare("SELECT user_id, role FROM role_binding ORDER BY user_id").all()).results, [
    { user_id: "curated", role: "system" },
    { user_id: "system", role: "system" },
  ]);
  // The references still hold: deleting the user takes what's theirs
  await db.prepare(`DELETE FROM "user" WHERE "id" = 'ivy'`).run();
  for (const table of CHILDREN) {
    assert.deepEqual((await db.prepare(`SELECT * FROM ${table} WHERE ${OWNERS[table]} = 'ivy'`).all()).results, [], table);
  }
});
