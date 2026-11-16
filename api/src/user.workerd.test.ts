import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Timestamp } from "@skolia/shared/api";
import * as schemas from "@skolia/shared/schemas";
import { type TableColumn, tableColumns, timestampNames } from "@skolia/util/checks";
import { sql } from "@skolia/util/sql";
import { startLocal, type Local } from "./testing/harness.ts";
import { MIGRATIONS } from "./user/migrations/index.ts";
import { checksum } from "./user/migrator.ts";
import { BLANK_DOCUMENT, BLANK_START, cardsQuery, readingListQuery } from "./user/queries.ts";

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
      "select name, strict, wr from pragma_table_list where name in ('card', 'review', 'settings', 'migration_log', 'reading_list', 'row_count') order by name",
    ),
    [
      { name: "card", strict: 1, wr: 1 },
      { name: "migration_log", strict: 1, wr: 0 },
      { name: "reading_list", strict: 1, wr: 1 },
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
      "insert into reading_list values (?, 'pl', 'to-read', '2026-11-07T00:00:00Z', '2026-11-07T00:00:00.000Z')",
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
    const query = readingListQuery(
      { status: "to-read", lang: inLang ? "pl" : undefined },
      { after: after ? schemas.ReadingKey.parse(["2026-11-07T00:00:00.000Z", "0".repeat(64)]) : undefined, limit: 3 },
    );
    const plan = (await storage.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query.sql.text}`, ...query.sql.params)).map(
      (row) => row.detail,
    );
    const index = inLang ? "reading_list_lang" : "reading_list_status";
    assert.ok(
      plan.length === 1 && plan[0]!.startsWith(`SEARCH reading_list USING INDEX ${index} `),
      `${inLang} ${after}: ${plan.join("; ")}`,
    );
  }
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

test("card_list's down drops its index, keeping the cards", async () => {
  const kim = local.env.USER.getByName("kim");
  await kim.makeCard({ kind: "recognition", lemmaId: "pl:pies:NOUN", data: {} }, AT);
  await kim.makeCard({ kind: "production", lemmaId: "pl:pies:NOUN", data: {} }, AT);
  await kim.migrate(8);
  const storage = await storageOf("kim");
  assert.deepEqual(await storage.exec("select name from sqlite_master where name = 'card_listed'"), []);
  await kim.migrate(LATEST);
  assert.deepEqual((await kim.cards({ lang: "pl", limit: 10 })).items.map((c) => c.kind).sort(), ["production", "recognition"]);
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
  await assert.rejects(storage.exec("update card set fsrs = json_set(fsrs, '$.scheduleStatus', 'lost')"));
});

test("cloze's migration keeps the word cards and their reviews, and down takes the cloze cards away", async () => {
  const at = schemas.Timestamp.parse("2026-11-07T00:00:00.000Z");
  const judy = local.env.USER.getByName("judy");
  await judy.migrate(3);
  const storage = await storageOf("judy");
  // A version 3 word and cards, with the ts-fsrs state a newer object gives them
  const ken = local.env.USER.getByName("ken");
  await ken.makeCard({ kind: "recognition", lemmaId: "pl:pies:NOUN", data: {} }, at);
  await ken.makeCard({ kind: "production", lemmaId: "pl:pies:NOUN", data: {} }, at);
  const fsrs = await (await storageOf("ken")).exec<{ kind: string; fsrs: string }>("select kind, fsrs from card order by kind");
  await storage.exec("insert into word values ('pl:pies:NOUN', 'active', ?)", at);
  for (const [i, { kind, fsrs: state }] of fsrs.entries()) {
    await storage.exec(
      "insert into card (id, lemma_id, kind, created, active, fsrs) values (?, 'pl:pies:NOUN', ?, ?, 1, ?)",
      `c${i}`,
      kind,
      at,
      state,
    );
  }
  await storage.exec("insert into review values ('r0', 'c0', 3, ?)", at);
  const cards = "select id, lemma_id, kind, active, fsrs from card order by id";
  const before = await storage.exec(cards);

  await judy.migrate(4);
  assert.deepEqual(await storage.exec(cards), before);
  assert.deepEqual(await storage.exec("select id, card_id from review"), [{ id: "r0", card_id: "c0" }]);
  assert.deepEqual(await storage.exec("pragma foreign_key_check"), []);
  await assert.rejects(
    storage.exec(
      "insert into card (id, lemma_id, kind, created, active, fsrs) values ('c9', 'pl:pies:NOUN', 'production', ?, 1, ?)",
      at,
      fsrs[0]!.fsrs,
    ),
  );
  const documentId = schemas.DocumentId.parse("a".repeat(64));
  const clozeRow =
    "insert into cloze (card_id, document_id, sentence, sentence_start, blank_start, blank_end, feats) values (?, ?, 'Widzę psa.', 0, 0, 5, '{}')";
  // A cloze row belongs to a cloze card, not a word's card or none
  await assert.rejects(storage.exec(clozeRow, "c0", documentId));
  await assert.rejects(storage.exec(clozeRow, "nope", documentId));
  await assert.rejects(
    storage.exec(
      "insert into cloze (card_id, kind, document_id, sentence, sentence_start, blank_start, blank_end, feats) values (?, 'recognition', ?, 'Widzę psa.', 0, 0, 5, '{}')",
      "c0",
      documentId,
    ),
  );

  // Deleting a card deletes its cloze row and reviews
  await storage.exec("insert into review values ('r1', 'c1', 3, ?)", at);
  await storage.exec("delete from card where id = 'c1'");
  assert.deepEqual(await storage.exec("select id from review where card_id = 'c1'"), []);
  await storage.exec(
    "insert into card (id, lemma_id, kind, created, active, fsrs) values ('z0', 'pl:pies:NOUN', 'cloze', ?, 1, ?)",
    at,
    fsrs[0]!.fsrs,
  );
  await storage.exec(clozeRow, "z0", documentId);
  await storage.exec("insert into review values ('r2', 'z0', 3, ?)", at);
  await storage.exec("delete from card where id = 'z0'");
  assert.deepEqual(await storage.exec("select count(*) as n from cloze"), [{ n: 0 }]);
  assert.deepEqual(await storage.exec("select count(*) as n from review where card_id = 'z0'"), [{ n: 0 }]);
  await storage.exec(
    "insert into card (id, lemma_id, kind, created, active, fsrs) values ('c1', 'pl:pies:NOUN', ?, ?, 1, ?)",
    fsrs[1]!.kind,
    at,
    fsrs[1]!.fsrs,
  );

  // The cards' methods are the latest migration's
  await judy.migrate(LATEST);
  const made = await judy.makeCard(
    {
      kind: "cloze",
      lemmaId: "pl:pies:NOUN",
      data: { documentId, sentence: "Widzę psa.", sentenceStart: 0, blankStart: 6, blankEnd: 9, feats: { Case: "Acc" }, why: null },
    },
    at,
  );
  assert.ok(made.kind === "made");
  await judy.review({ id: schemas.ReviewId.parse(crypto.randomUUID()), cardId: made.cardId, rating: 3, at }, at);

  await judy.migrate(3);
  assert.deepEqual(await storage.exec(cards), before);
  assert.deepEqual(await storage.exec("select id from review"), [{ id: "r0" }]);
  assert.ok(!(await tables("judy")).includes("cloze"));
  assert.deepEqual(await storage.exec("pragma foreign_key_check"), []);
});

test("row_count's triggers keep the count of cards of every kind however one goes, and its migrations count those there are", async () => {
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

  await mia.migrate(10);
  assert.deepEqual(await counts(), [{ name: "cloze", n: 2 }]);
  assert.deepEqual(await storage.exec("select name from sqlite_master where type = 'trigger' and tbl_name = 'card'"), []);
  await storage.exec("delete from card where id in (select card_id from cloze where blank_start = 0)");
  assert.deepEqual(await counts(), [{ name: "cloze", n: 1 }]);
  await mia.migrate(7);
  assert.ok(!(await tables("mia")).includes("row_count"));
  assert.deepEqual(await storage.exec("select name from sqlite_master where type = 'trigger' and tbl_name = 'cloze'"), []);
  await mia.migrate(8);
  assert.deepEqual(await counts(), [{ name: "cloze", n: 1 }]);

  await mia.migrate(LATEST);
  assert.deepEqual(await counts(), [{ name: "card", n: 2 }]);
  await mia.makeCard({ kind: "production", lemmaId: "pl:pies:NOUN", data: {} }, at);
  assert.deepEqual(await counts(), [{ name: "card", n: 3 }]);
});

test("card_data moves each cloze row into its card's data, gives a word's cards {}, and down moves them back", async () => {
  const olga = local.env.USER.getByName("olga");
  await olga.migrate(11);
  const storage = await storageOf("olga");
  const fsrs = JSON.stringify({ dueAt: AT, scheduleStatus: "new", scheduledDays: 0 });
  const card = "insert into card (id, lemma_id, kind, created_at, active, fsrs) values (?, 'pl:pies:NOUN', ?, ?, 1, ?)";
  await storage.exec(card, "c0", "recognition", AT, fsrs);
  await storage.exec(card, "c1", "cloze", AT, fsrs);
  await storage.exec(
    "insert into cloze (card_id, document_id, sentence, sentence_start, blank_start, blank_end, feats) values ('c1', ?, 'Widzę psa.', 0, 6, 9, ?)",
    "a".repeat(64),
    JSON.stringify({ Case: "Acc", Number: "Sing" }),
  );
  const clozes = "select * from cloze";
  const before = await storage.exec(clozes);

  await olga.migrate(12);
  assert.ok(!(await tables("olga")).includes("cloze"));
  const rows = await storage.exec<{ id: string; data: string }>("select id, data from card order by id");
  assert.deepEqual(
    rows.map((r) => [r.id, JSON.parse(r.data)]),
    [
      ["c0", {}],
      [
        "c1",
        {
          documentId: "a".repeat(64),
          sentence: "Widzę psa.",
          sentenceStart: 0,
          blankStart: 6,
          blankEnd: 9,
          feats: { Case: "Acc", Number: "Sing" },
          why: null,
        },
      ],
    ],
  );
  // card_blank keeps a text's blank to one cloze card
  await assert.rejects(
    storage.exec(
      "insert into card (id, lemma_id, kind, created_at, active, fsrs, data) select 'c2', lemma_id, kind, created_at, active, fsrs, data from card where id = 'c1'",
    ),
    /UNIQUE constraint failed/,
  );
  await assert.rejects(storage.exec("update card set data = '[]' where id = 'c0'"), /CHECK constraint failed/);

  await olga.migrate(11);
  assert.deepEqual(await storage.exec(clozes), before);
  assert.deepEqual(await storage.exec("select name from pragma_table_info('card') where name = 'data'"), []);
});

test("card_groups' migration keeps the user's new cards a day as new words a day, and down restores it", async () => {
  const lia = local.env.USER.getByName("lia");
  await lia.migrate(4);
  const storage = await storageOf("lia");
  await storage.exec("update settings set new_per_day = 7");
  // A plain object, not the RPC result's stub
  const settings = async () => ({ ...(await lia.settings()) });

  await lia.migrate(5);
  assert.deepEqual(await settings(), { newLemmasPerDay: 7, newFormsPerDay: 20, formsWithWords: true });
  await assert.rejects(storage.exec("update settings set new_lemmas_per_day = 1001"));
  await assert.rejects(storage.exec("update settings set new_forms_per_day = 1001"));
  await assert.rejects(storage.exec("update settings set forms_with_words = 2"));
  await lia.setSettings({ newLemmasPerDay: 8, newFormsPerDay: 3, formsWithWords: false });

  await lia.migrate(4);
  assert.deepEqual(await storage.exec("select * from settings"), [{ id: 1, new_per_day: 8 }]);
  await lia.migrate(5);
  assert.deepEqual(await settings(), { newLemmasPerDay: 8, newFormsPerDay: 20, formsWithWords: true });
});

test("cards_own_words keeps known and ignored words as known cards, and down gives each word its cards' status", async () => {
  const noah = local.env.USER.getByName("noah");
  const pies = await noah.makeCard({ kind: "recognition", lemmaId: "pl:pies:NOUN", data: {} }, AT);
  const dom = await noah.makeCard({ kind: "recognition", lemmaId: "pl:dom:NOUN", data: {} }, AT);
  assert.ok(pies.kind === "made" && dom.kind === "made");
  await noah.setCardState(dom.cardId, "known");
  await noah.migrate(9);
  const storage = await storageOf("noah");
  const words = "select lemma_id, status, updated_at from word order by lemma_id";
  assert.deepEqual(await storage.exec(words), [
    { lemma_id: "pl:dom:NOUN", status: "known", updated_at: AT },
    { lemma_id: "pl:pies:NOUN", status: "active", updated_at: AT },
  ]);
  const kot = schemas.Timestamp.parse("2026-11-08T00:00:00.000Z");
  await storage.exec("insert into word values ('pl:kot:NOUN', 'known', ?), ('pl:Ola:PROPN', 'ignored', ?)", kot, AT);

  await noah.migrate(LATEST);
  assert.ok(!(await tables("noah")).includes("word"));
  const cards = async (lemmaId: "pl:pies:NOUN" | "pl:dom:NOUN" | "pl:kot:NOUN" | "pl:Ola:PROPN") =>
    (await noah.cards({ lemmaId, limit: 10 })).items.map((c) => [c.kind, c.state, c.scheduleStatus, c.createdAt, c.dueAt]);
  assert.deepEqual(await cards("pl:pies:NOUN"), [["recognition", "learning", "new", AT, AT]]);
  assert.deepEqual(await cards("pl:dom:NOUN"), [["recognition", "known", "new", AT, AT]]);
  assert.deepEqual(await cards("pl:kot:NOUN"), [["recognition", "known", "new", kot, kot]]);
  assert.deepEqual(await cards("pl:Ola:PROPN"), [["recognition", "known", "new", AT, AT]]);
  const [made] = (await noah.cards({ lemmaId: "pl:kot:NOUN", limit: 1 })).items;
  assert.ok(made);
  assert.match(made.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(await storage.exec("select fsrs ->> '$.cardId' as id from card where id = ?", made.id), [{ id: made.id }]);
  // It's reviewed as a card ts-fsrs made is
  assert.ok(await noah.setCardState(made.id, "learning"));
  const reviewed = await noah.review({ id: schemas.ReviewId.parse(crypto.randomUUID()), cardId: made.id, rating: 3, at: kot }, kot);
  assert.equal(reviewed.kind, "reviewed");

  await noah.migrate(9);
  assert.deepEqual(await storage.exec(words), [
    { lemma_id: "pl:Ola:PROPN", status: "known", updated_at: AT },
    { lemma_id: "pl:dom:NOUN", status: "known", updated_at: AT },
    { lemma_id: "pl:kot:NOUN", status: "active", updated_at: kot },
    { lemma_id: "pl:pies:NOUN", status: "active", updated_at: AT },
  ]);
});
