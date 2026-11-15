import assert from "node:assert/strict";
import { test } from "node:test";
import { iso, isoChecked, isoOrNull, timestampNames } from "./checks.ts";

test("a column is iso-checked by its own check, quoted or not, however the table's SQL is spaced", () => {
  const table = `CREATE TABLE t (
  added_at TEXT NOT NULL ${iso("added_at")},
  "seenAt" TEXT ${isoOrNull('"seenAt"')},
  updated_at TEXT NOT NULL CHECK (updated_at IS
    strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  at TEXT,
  due TEXT CHECK (due IS strftime('%Y-%m-%d', due)),
  other_at TEXT CHECK (added_at IS strftime('%Y-%m-%dT%H:%M:%fZ', other_at))
)`;
  assert.deepEqual(
    ["added_at", "seenAt", "updated_at", "at", "due", "other_at"].filter((column) => isoChecked(table, column)),
    ["added_at", "seenAt", "updated_at"],
  );
});

test("timestampNames finds timestamps not named _at, and _at columns that aren't timestamps", () => {
  const sql = `CREATE TABLE t (at TEXT ${iso("at")}, added_at TEXT ${iso("added_at")}, done_at TEXT, name TEXT)`;
  const columns = ["at", "added_at", "done_at", "name"].map((column) => ({ table: "t", sql, column }));
  assert.deepEqual(timestampNames(columns), { unnamed: ["t.at"], unchecked: ["t.done_at"] });
});
