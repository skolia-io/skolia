import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Timestamp } from "@skolia/shared/api";
import * as schemas from "@skolia/shared/schemas";
import { type TableColumn, tableColumns, timestampNames } from "@skolia/util/checks";
import { sql } from "@skolia/util/sql";
import { startLocal, type Local } from "./testing/harness.ts";
import { MIGRATIONS } from "./user/migrations/index.ts";
import { checksum } from "./user/migrator.ts";
import { BLANK_DOCUMENT, BLANK_START, cardsQuery, readingProgressQuery, readingListDocumentsQuery } from "./user/queries.ts";

let local: Local;

before(async () => {
  local = await startLocal();
});
after(() => local?.close());

const LATEST = MIGRATIONS.length;
const AT = schemas.Timestamp.parse("2026-11-07T00:00:00.000Z");

function storageOf(name: string) {
  return local.server.getWorker().getDurableObjectStorage("User", { name });
}

async function tables(name: string): Promise<string[]> {
  const rows = await (await storageOf(name)).exec<{ name: string }>("select name from sqlite_master where type = 'table'");
  return rows.map((t) => t.name);
}

test("each user's Durable Object keeps its own cards", async () => {
  const alice = local.env.USER.getByName("alice");
  const made = await alice.makeCard({ kind: "recognition", lemmaId: "pl:pies:NOUN", data: {} }, AT);
  assert.ok(made.kind === "made");
  assert.ok(await alice.setCardState(made.cardId, "known"));
  const { items, next } = await alice.cards({ lemmaId: "pl:pies:NOUN", limit: 10 });
  assert.deepEqual(
    items.map((c) => [c.id, c.kind, c.state, c.createdAt]),
    [[made.cardId, "recognition", "known", AT]],
  );
  assert.equal(next, null);
  assert.deepEqual((await local.env.USER.getByName("bob").cards({ lemmaId: "pl:pies:NOUN", limit: 10 })).items, []);
  assert.equal(await local.env.USER.getByName("bob").setCardState(made.cardId, "known"), false);
});

test("a new object migrates to the latest version and logs each migration with its checksum", async () => {
  const status = await local.env.USER.getByName("carol").migrationStatus();
  assert.equal(status.version, LATEST);
  assert.deepEqual(status.problems, []);
  assert.deepEqual(
    status.log.map((e) => [e.version, e.name, e.direction, e.checksum]),
    await Promise.all(MIGRATIONS.map(async (m) => [m.version, m.name, "up", await checksum(m.up)])),
  );
});

test("migrating down and back up appends to the log instead of rewriting it", async () => {
  const dave = local.env.USER.getByName("dave");
  await dave.migrate(0);
  assert.ok(!(await tables("dave")).includes("card"));
  await dave.migrate(LATEST);
  assert.ok((await tables("dave")).includes("card"));
  const { version, log } = await dave.migrationStatus();
  assert.equal(version, LATEST);
  const ups = MIGRATIONS.map((m) => [m.version, "up"]);
  const downs = MIGRATIONS.map((m) => [m.version, "down"]).reverse();
  assert.deepEqual(
    log.map((e) => [e.version, e.direction]),
    [...ups, ...downs, ...ups],
  );
  assert.deepEqual(
    log.map((e) => e.seq),
    [...log.map((e) => e.seq)].sort((a, b) => a - b),
  );
  assert.equal(log[LATEST]?.checksum, await checksum(MIGRATIONS[LATEST - 1]!.down));
  await assert.rejects(dave.migrate(LATEST + 1));
});

test("the log can't be updated or deleted from", async () => {
  await local.env.USER.getByName("erin").settings();
  const storage = await storageOf("erin");
  await assert.rejects(storage.exec("update migration_log set name = 'other'"), /append-only/);
  await assert.rejects(storage.exec("delete from migration_log"), /append-only/);
  const { log } = await local.env.USER.getByName("erin").migrationStatus();
  assert.deepEqual(
    log.map((e) => e.name),
    MIGRATIONS.map((m) => m.name),
  );
});

test("an applied migration that was edited, or that the code doesn't have, stops migrating", async () => {
  const frank = local.env.USER.getByName("frank");
  await frank.migrate(0);
  const storage = await storageOf("frank");
  const insert =
    "insert into migration_log (version, name, direction, checksum, applied_at) values (?, ?, 'up', ?, '2026-11-07T00:00:00.000Z')";
  await storage.exec(insert, 1, MIGRATIONS[0]!.name, "edited");
  assert.deepEqual((await frank.migrationStatus()).problems, [`version 1 (${MIGRATIONS[0]!.name}) was edited after it was applied`]);
  await assert.rejects(frank.migrate(0));

  const grace = local.env.USER.getByName("grace");
  await grace.settings();
  await (await storageOf("grace")).exec(insert, LATEST + 1, "from_the_future", "x");
  assert.deepEqual((await grace.migrationStatus()).problems, [`version ${LATEST + 1} (from_the_future) is applied but isn't in the code`]);
  await assert.rejects(grace.migrate(LATEST));
});

test("with MUTABLE_FINAL_USER_MIGRATION, an edited last migration is reverted with the down it was applied with, then applied again", async () => {
  const mallory = local.env.USER.getByName("mallory");
  await mallory.migrate(LATEST - 1);
  const last = MIGRATIONS[LATEST - 1]!;
  const storage = await storageOf("mallory");
  await storage.exec("create table draft (id text)");
  await storage.exec(
    "insert into migration_log (version, name, direction, checksum, down, applied_at) values (?, ?, 'up', 'edited', 'DROP TABLE draft', '2026-11-07T00:00:00.000Z')",
    LATEST,
    last.name,
  );
  assert.deepEqual((await mallory.migrationStatus()).problems, []);
  await mallory.migrate(LATEST);
  assert.ok(!(await tables("mallory")).includes("draft"));
  const { version, log } = await mallory.migrationStatus();
  assert.equal(version, LATEST);
  assert.deepEqual(
    log.slice(-3).map((e) => [e.version, e.direction, e.checksum, e.down]),
    [
      [LATEST, "up", "edited", "DROP TABLE draft"],
      [LATEST, "down", await checksum("DROP TABLE draft"), null],
      [LATEST, "up", await checksum(last.up), last.down],
    ],
  );
});

test("the tables are STRICT, the user's are WITHOUT ROWID, and timestamps must be toISOString()'s", async () => {
  const heidi = local.env.USER.getByName("heidi");
  await heidi.settings();
  const storage = await storageOf("heidi");
  assert.deepEqual(
    await storage.exec(
      "select name, strict, wr from pragma_table_list where name in ('card', 'review', 'settings', 'migration_log', 'reading_progress', 'row_count') order by name",
    ),
    [
      { name: "card", strict: 1, wr: 1 },
      { name: "migration_log", strict: 1, wr: 0 },
      { name: "reading_progress", strict: 1, wr: 1 },
      { name: "review", strict: 1, wr: 1 },
      { name: "row_count", strict: 1, wr: 1 },
      { name: "settings", strict: 1, wr: 0 },
    ],
  );
  await heidi.makeCard({ kind: "recognition", lemmaId: "pl:pies:NOUN", data: {} }, AT);
  for (const created of ["2026-11-07T00:00:00Z", "2026-11-07 00:00:00"]) {
    // Past the types, to check the table refuses them
    await assert.rejects(heidi.makeCard({ kind: "recognition", lemmaId: "pl:kot:NOUN", data: {} }, created as Timestamp));
  }
  await assert.rejects(storage.exec("insert into row_count values ('other', x'00')"), /cannot store BLOB/);
  assert.equal((await heidi.cards({ lang: "pl", limit: 10 })).items.length, 1);
  await assert.rejects(
    storage.exec(
      "insert into reading_progress values (?, 'pl', 'to-read', '2026-11-07T00:00:00Z', '2026-11-07T00:00:00.000Z')",
      "0".repeat(64),
    ),
    /CHECK constraint failed/,
  );
});

test("a column is a toISOString() timestamp exactly when its name ends in _at", async () => {
  await local.env.USER.getByName("heidi").settings();
  const query = tableColumns([]);
  const columns = await (await storageOf("heidi")).exec<TableColumn>(query.text, ...query.params);
  assert.ok(columns.some((c) => c.table === "card" && c.column === "due_at"));
  assert.deepEqual(timestampNames(columns), { unnamed: ["reading_position.at"], unchecked: [] });
});

test("a page of the reading list seeks to its key in an index, with or without a language, and sorts nothing", async () => {
  await local.env.USER.getByName("ivan").settings();
  const storage = await storageOf("ivan");
  for (const [inLang, after] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const) {
    const query = readingProgressQuery(
      { status: "to-read", lang: inLang ? "pl" : undefined },
      { after: after ? schemas.ReadingKey.parse(["2026-11-07T00:00:00.000Z", "0".repeat(64)]) : undefined, limit: 3 },
    );
    const plan = (await storage.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query.sql.text}`, ...query.sql.params)).map(
      (row) => row.detail,
    );
    const index = inLang ? "reading_list_lang" : "reading_list_status";
    assert.ok(
      plan.length === 1 && plan[0]!.startsWith(`SEARCH reading_progress USING INDEX ${index} `),
      `${inLang} ${after}: ${plan.join("; ")}`,
    );
  }
});

test("reading lists migrate saved texts without losing progress and maintain counts", async () => {
  const user = local.env.USER.getByName("reading-lists-migration");
  await user.migrate(1);
  const storage = await storageOf("reading-lists-migration");
  const documents = ["1", "2", "3"].map((digit) => schemas.DocumentId.parse(digit.repeat(64)));
  for (const [index, status] of ["to-read", "reading", "finished"].entries()) {
    await storage.exec("INSERT INTO reading_list VALUES (?, 'pl', ?, ?, ?)", documents[index]!, status, AT, AT);
  }
  await user.migrate(LATEST);
  const toRead = schemas.ReadingListId.parse("to-read");
  assert.deepEqual(
    (await user.readingLists()).map((list) => [list.id, list.documentsCount]),
    [[toRead, 1]],
  );
  assert.deepEqual(
    (await user.readingListDocuments(toRead, undefined, { limit: 10 }))?.items.map((item) => item.documentId),
    [documents[0]],
  );
  for (const [index, status] of ["to-read", "reading", "finished"].entries()) {
    const entry = await user.reading(documents[index]!);
    assert.equal(entry?.status, status);
    assert.equal(entry?.addedAt, AT);
    assert.equal(entry?.updatedAt, AT);
  }
  const id = schemas.ReadingListId.parse(crypto.randomUUID());
  assert.equal(await user.createReadingList(id, "Stories", AT), true);
  const save = { lang: "pl", addedAt: AT } as const;
  assert.equal(await user.setReadingListDocument(id, documents[0]!, save), true);
  assert.equal(await user.setReadingListDocument(id, documents[0]!, save), true);
  assert.equal((await user.readingLists()).find((list) => list.id === id)?.documentsCount, 1);
  assert.equal(await user.deleteReadingList(id), true);
  assert.deepEqual(await user.readingListMemberships(documents[0]!), [toRead]);
  assert.equal(await user.deleteReadingList(toRead), false);
  assert.equal(await user.renameReadingList(toRead, "Later"), true);
  assert.equal((await user.readingLists()).find((list) => list.id === toRead)?.name, "Later");
  assert.deepEqual(await user.readingListMemberships(documents[0]!), [toRead]);
  assert.equal((await user.reading(documents[0]!))?.status, "to-read");
});

test("reading list pages seek an index, with language and cursor, without sorting", async () => {
  await local.env.USER.getByName("reading-lists-plan").settings();
  const storage = await storageOf("reading-lists-plan");
  for (const lang of [undefined, "pl"] as const) {
    for (const after of [undefined, schemas.ReadingKey.parse([AT, "0".repeat(64)])]) {
      const query = readingListDocumentsQuery(schemas.ReadingListId.parse("to-read"), lang, { after, limit: 3 });
      const plan = (await storage.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query.text}`, ...query.params)).map((row) => row.detail);
      const index = lang ? "reading_list_document_lang" : "reading_list_document_page";
      assert.ok(plan.length === 1 && plan[0]!.startsWith(`SEARCH reading_list_document USING COVERING INDEX ${index} `), plan.join("; "));
    }
  }
});

test("reading lists are capped, and deleting one releases its slot", async () => {
  const user = local.env.USER.getByName("reading-lists-limit");
  const ids = Array.from({ length: 200 }, () => schemas.ReadingListId.parse(crypto.randomUUID()));
  for (const id of ids.slice(0, 199)) assert.equal(await user.createReadingList(id, "List", AT), true);
  assert.equal(await user.createReadingList(ids[199]!, "Too many", AT), false);
  assert.equal((await user.readingLists()).length, 200);
  assert.equal(await user.deleteReadingList(ids[0]!), true);
  assert.equal(await user.createReadingList(ids[199]!, "Room again", AT), true);
});

test("a page of cards seeks to its key in an index, in a language, a word or a text, and sorts nothing", async () => {
  await local.env.USER.getByName("ivan").settings();
  const storage = await storageOf("ivan");
  const newest = schemas.NewestCardKey.parse(["2026-11-07T00:00:00.000Z", "00000000-0000-4000-8000-000000000000"]);
  const listings = [false, true].flatMap((after) => [
    { index: "card_listed", listing: { lang: "pl" as const, after: after ? newest : undefined, limit: 3 } },
    { index: "card_lemma", listing: { lemmaId: "pl:pies:NOUN" as const, after: after ? newest : undefined, limit: 3 } },
    {
      index: "card_blank",
      listing: {
        documentId: schemas.DocumentId.parse("0".repeat(64)),
        after: after ? schemas.TextCardKey.parse([5]) : undefined,
        limit: 3,
      },
    },
  ]);
  for (const { index, listing } of listings) {
    const query = cardsQuery(listing);
    const plan = (await storage.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query.sql.text}`, ...query.sql.params)).map(
      (row) => row.detail,
    );
    const why = `${JSON.stringify(listing)}: ${plan.join("; ")}`;
    assert.ok(plan[0]?.startsWith(`SEARCH card USING INDEX ${index} `), why);
    assert.ok(
      plan.slice(1).every((d) => d.startsWith("SEARCH ") && !d.includes("TEMP B-TREE")),
      why,
    );
  }
});

test("makeCard finds a text's cloze card at the blank by seeking card_blank", async () => {
  await local.env.USER.getByName("ivan").settings();
  const storage = await storageOf("ivan");
  const query = sql`SELECT id FROM card WHERE kind = 'cloze' AND ${BLANK_DOCUMENT} = ${"0".repeat(64)} AND ${BLANK_START} = ${6}`;
  const plan = (await storage.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query.text}`, ...query.params)).map((row) => row.detail);
  assert.equal(plan.length, 1, plan.join("; "));
  assert.ok(plan[0]!.startsWith("SEARCH card USING INDEX card_blank "), plan.join("; "));
});

test("a word's cards are stored with their ts-fsrs state, which gives their due time", async () => {
  const ivan = local.env.USER.getByName("ivan");
  await ivan.makeCard({ kind: "recognition", lemmaId: "pl:pies:NOUN", data: {} }, AT);
  await ivan.makeCard({ kind: "production", lemmaId: "pl:pies:NOUN", data: {} }, AT);
  const storage = await storageOf("ivan");
  const rows = await storage.exec<{ kind: string; due_at: string; schedule_status: string; fsrs: string }>(
    "select kind, due_at, schedule_status, fsrs from card order by kind",
  );
  assert.deepEqual(
    rows.map((r) => [r.kind, r.due_at, r.schedule_status]),
    [
      ["production", "2026-11-07T00:00:00.000Z", "new"],
      ["recognition", "2026-11-07T00:00:00.000Z", "new"],
    ],
  );
  await assert.rejects(storage.exec("update card set fsrs = json_remove(fsrs, '$.scheduleStatus')"), /NOT NULL constraint failed/);
});

test("row_count's triggers keep the count of cards of every kind however one goes", async () => {
  const at = schemas.Timestamp.parse("2026-11-07T00:00:00.000Z");
  const mia = local.env.USER.getByName("mia");
  await mia.migrate(LATEST);
  const storage = await storageOf("mia");
  const data = {
    documentId: schemas.DocumentId.parse("a".repeat(64)),
    sentence: "Widzę psa.",
    sentenceStart: 0,
    blankStart: 6,
    blankEnd: 9,
    feats: { Case: "Acc" },
    why: null,
  };
  const cloze = { kind: "cloze" as const, lemmaId: "pl:pies:NOUN" as const, data };
  const other = { ...cloze, data: { ...data, blankStart: 0, blankEnd: 5 } };
  const counts = () => storage.exec<{ name: string; n: number }>("select name, n from row_count order by name");
  assert.deepEqual(await counts(), [{ name: "card", n: 0 }]);
  const made = await mia.makeCard(cloze, at);
  assert.ok(made.kind === "made");
  await mia.makeCard(other, at);
  await mia.makeCard({ kind: "recognition", lemmaId: "pl:pies:NOUN", data: {} }, at);
  await mia.makeCard({ kind: "production", lemmaId: "pl:pies:NOUN", data: {} }, at);
  assert.equal((await mia.makeCard(cloze, at)).kind, "had");
  assert.equal((await mia.makeCard({ kind: "recognition", lemmaId: "pl:pies:NOUN", data: {} }, at)).kind, "had");
  assert.deepEqual(await counts(), [{ name: "card", n: 4 }]);
  assert.ok(await mia.deleteCard(made.cardId));
  assert.deepEqual(await counts(), [{ name: "card", n: 3 }]);
  await storage.exec("delete from card where kind = 'production'");
  assert.deepEqual(await counts(), [{ name: "card", n: 2 }]);
  await mia.makeCard(cloze, at);
  assert.deepEqual(await counts(), [{ name: "card", n: 3 }]);
});
