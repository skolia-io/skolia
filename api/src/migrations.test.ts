import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const DIR = join(import.meta.dirname, "..", "migrations");
const MIGRATIONS = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** A database with the migrations before this one applied, as D1 applies them. */
function migratedUpTo(name: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of MIGRATIONS.slice(0, MIGRATIONS.indexOf(name))) db.exec(readFileSync(join(DIR, file), "utf8"));
  return db;
}

test("0007 makes each document its text's content and its importer's entry", () => {
  const db = migratedUpTo("0007_user_document.sql");
  db.exec(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
           VALUES ('ivy', 'Ivy', 'ivy@example.com', 0, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`);
  db.exec(`INSERT INTO document VALUES
    ('a', 'Lalka', 'pl', '2026-11-02T00:00:00.000Z', 72, 'curated', 'public', 'public-domain', 'Bolesław Prus', 'https://example.org/lalka', 'curated'),
    ('b', 'Notatki', 'pl', '2026-11-03T00:00:00.000Z', 3, 'ivy', 'private', 'unknown', NULL, NULL, 'ivy')`);
  db.exec(readFileSync(join(DIR, "0007_user_document.sql"), "utf8"));
  assert.deepEqual(
    db
      .prepare("SELECT * FROM document ORDER BY id")
      .all()
      .map((r) => ({ ...r })),
    [
      { id: "a", lang: "pl", words: 72 },
      { id: "b", lang: "pl", words: 3 },
    ],
  );
  assert.deepEqual(
    db
      .prepare("SELECT * FROM user_document ORDER BY document_id")
      .all()
      .map((r) => ({ ...r })),
    [
      {
        user_id: "curated",
        document_id: "a",
        title: "Lalka",
        imported_at: "2026-11-02T00:00:00.000Z",
        visibility: "public",
        licence: "public-domain",
        author: "Bolesław Prus",
        source: "https://example.org/lalka",
      },
      {
        user_id: "ivy",
        document_id: "b",
        title: "Notatki",
        imported_at: "2026-11-03T00:00:00.000Z",
        visibility: "private",
        licence: "unknown",
        author: null,
        source: null,
      },
    ],
  );
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'document_0006'").get(), undefined);
});

test("0011 moves entries' and annotations' licences, authors and sources to one attribution row each, and keeps their tags and annotations", () => {
  const db = migratedUpTo("0011_attribution.sql");
  db.exec(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
           VALUES ('ivy', 'Ivy', 'ivy@example.com', 0, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`);
  db.exec(`INSERT INTO document VALUES ('a', 'pl', 72), ('b', 'pl', 3)`);
  db.exec(`INSERT INTO user_document (user_id, document_id, title, imported_at, visibility, licence, author, source) VALUES
    ('ivy', 'a', 'Bajka', '2026-11-02T00:00:00.000Z', 'public', 'cc-by-nc', 'Ala', 'https://example.org/a'),
    ('ivy', 'b', 'Notatki', '2026-11-03T00:00:00.000Z', 'private', 'unknown', '', NULL)`);
  db.exec(`INSERT INTO user_document_tag VALUES ('ivy', 'a', 'level', 'A1')`);
  db.exec(`INSERT INTO user_document_annotation (user_id, document_id, id, start, "end", kind, data, licence, author, source, added_at) VALUES
    ('ivy', 'a', 'x', 0, 1, 'audio', '{"url":"https://example.org/x.mp3"}', 'cc-by-nc', 'Ala', 'https://example.org/a', '2026-11-04T00:00:00.000Z'),
    ('ivy', 'a', 'y', 1, 2, 'audio', '{"url":"https://example.org/y.mp3"}', 'cc0', NULL, NULL, '2026-11-04T00:00:00.000Z')`);
  db.exec(readFileSync(join(DIR, "0011_attribution.sql"), "utf8"));
  const all = (query: string) =>
    db
      .prepare(query)
      .all()
      .map((r) => ({ ...r }));
  assert.deepEqual(all("SELECT licence, author, source FROM attribution ORDER BY licence"), [
    { licence: "cc-by-nc-4.0", author: "Ala", source: "https://example.org/a" },
    { licence: "cc0", author: null, source: null },
    { licence: "unknown", author: null, source: null },
  ]);
  assert.deepEqual(
    all(`SELECT entry.document_id, entry.title, entry.visibility, entry.annotations_count, attribution.licence, attribution.author FROM user_document entry
         JOIN attribution ON attribution.id = entry.attribution_id ORDER BY entry.document_id`),
    [
      { document_id: "a", title: "Bajka", visibility: "public", annotations_count: 2, licence: "cc-by-nc-4.0", author: "Ala" },
      { document_id: "b", title: "Notatki", visibility: "private", annotations_count: 0, licence: "unknown", author: null },
    ],
  );
  assert.deepEqual(
    all(
      "SELECT annotation.id, attribution.licence FROM user_document_annotation annotation JOIN attribution ON attribution.id = annotation.attribution_id ORDER BY annotation.id",
    ),
    [
      { id: "x", licence: "cc-by-nc-4.0" },
      { id: "y", licence: "cc0" },
    ],
  );
  assert.deepEqual(all("SELECT * FROM user_document_tag"), [{ user_id: "ivy", document_id: "a", kind: "level", value: "A1" }]);
  assert.deepEqual(all("SELECT name FROM sqlite_master WHERE name GLOB '*_0010'"), []);
  db.exec("DELETE FROM user_document_annotation WHERE id = 'y'");
  assert.deepEqual(all("SELECT annotations_count FROM user_document WHERE document_id = 'a'"), [{ annotations_count: 1 }]);
  db.exec("DELETE FROM user_document WHERE document_id = 'a'");
  assert.deepEqual(all("SELECT count(*) AS n FROM user_document_tag, user_document_annotation"), [{ n: 0 }]);
  assert.deepEqual(all("PRAGMA foreign_key_check"), []);
});
