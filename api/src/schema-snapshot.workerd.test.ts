import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import { startLocal } from "./testing/harness.ts";

const SCHEMA = `SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL
  AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__miniflare_*'
  ORDER BY tbl_name, CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`;
type Definition = { name: string; sql: string };

function ddl(rows: readonly Definition[]): string {
  return `${rows.map((row) => `${row.sql};`).join("\n\n")}\n`;
}

async function snapshot(name: string, actual: string): Promise<void> {
  const file = new URL(`../schema/${name}.sql`, import.meta.url);
  if (process.env["UPDATE_SCHEMA_SNAPSHOTS"] === "1") await writeFile(file, actual);
  else assert.equal(actual, await readFile(file, "utf8"));
}

test("fresh API and User databases match the checked-in schema snapshots", async (t) => {
  const local = await startLocal();
  t.after(() => local.close());
  const { results } = await local.env.DB.prepare(SCHEMA).all<Definition>();
  await snapshot("api", ddl(results.filter((row) => row.name !== "d1_migrations")));
  assert.deepEqual((await local.env.DB.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.deepEqual((await local.env.DB.prepare(`SELECT id FROM "user" WHERE role = 'system' ORDER BY id`).all()).results, [
    { id: "curated" },
    { id: "system" },
  ]);
  const name = "schema-snapshot";
  await local.env.USER.getByName(name).migrationStatus();
  const storage = await local.server.getWorker().getDurableObjectStorage("User", { name });
  await snapshot("user", ddl(await storage.exec<Definition>(SCHEMA)));
  assert.deepEqual(await storage.exec("PRAGMA foreign_key_check"), []);
  await assert.rejects(
    storage.exec(`INSERT INTO review (id, card_id, rating, reviewed_at)
      VALUES ('fk-test', 'missing-card', 1, '2026-01-01T00:00:00.000Z')`),
    /FOREIGN KEY constraint failed/,
  );
  assert.deepEqual(await storage.exec("SELECT name, n FROM row_count ORDER BY name"), [{ name: "card", n: 0 }]);
  assert.equal(
    (await storage.exec<{ new_lemmas_per_day: number }>("SELECT new_lemmas_per_day FROM settings WHERE id = 1"))[0]?.new_lemmas_per_day,
    20,
  );
});
