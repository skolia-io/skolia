import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Timestamp } from "@skolia/shared/api";
import * as schemas from "@skolia/shared/schemas";
import { type TableColumn, tableColumns, timestampNames } from "@skolia/util/checks";
import { sql } from "@skolia/util/sql";
import { startLocal, type Local } from "./testing/harness.ts";
import { MIGRATIONS } from "./user/migrations/index.ts";
import { checksum } from "./user/migrator.ts";
import * as queries from "./user/queries.ts";
import { BLANK_DOCUMENT, BLANK_START, cardsQuery, readingListDocumentsQuery } from "./user/queries.ts";

let local: Local;

before(async () => {
  local = await startLocal();
});
after(() => local?.close());

const LATEST = MIGRATIONS.length;
const AT = schemas.Timestamp.parse("2026-11-07T00:00:00.000Z");

/** The steps of a query plan that read a table or an index other than by seeking it, or sort:
 * a SCAN of anything but a subquery's rows (picked, fresh: freshQuery's) or a constant row, or a
 * temporary B-tree. */
function unseeked(plan: readonly string[]): readonly string[] {
  return plan.filter(
    (d) => (d.startsWith("SCAN ") && !/^SCAN (\(subquery-\d+\)|CONSTANT ROW|picked|fresh)$/u.test(d)) || d.includes("TEMP B-TREE"),
  );
}

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
  assert.ok(await alice.setWordState("pl:pies:NOUN", "known"));
  const { items, next } = await alice.cards({ lemmaId: "pl:pies:NOUN", limit: 10 });
  assert.deepEqual(
    items.map((c) => [c.id, c.kind, c.state, c.createdAt]),
    [[made.cardId, "recognition", "known", AT]],
  );
  assert.equal(next, null);
  assert.deepEqual((await local.env.USER.getByName("bob").cards({ lemmaId: "pl:pies:NOUN", limit: 10 })).items, []);
  assert.equal(await local.env.USER.getByName("bob").setWordState("pl:pies:NOUN", "known"), false);
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
    log.map((e) => e.seq).sort((a, b) => a - b),
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
      "select name, strict, wr from pragma_table_list where name in ('card', 'review', 'settings', 'migration_log', 'rate_window', 'reading_list', 'reading_list_document', 'row_count') order by name",
    ),
    [
      { name: "card", strict: 1, wr: 1 },
      { name: "migration_log", strict: 1, wr: 0 },
      { name: "rate_window", strict: 1, wr: 1 },
      { name: "reading_list", strict: 1, wr: 0 },
      { name: "reading_list_document", strict: 1, wr: 1 },
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
    storage.exec("insert into reading_list_document values (1, ?, 'pl', '2026-11-07T00:00:00Z')", "0".repeat(64)),
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

test("reading lists migrate each status into a list without touching the resume position", async () => {
  const user = local.env.USER.getByName("reading-lists-migration");
  await user.migrate(1);
  const storage = await storageOf("reading-lists-migration");
  const documents = ["1", "2", "3"].map((digit) => schemas.DocumentId.parse(digit.repeat(64)));
  for (const [index, status] of ["to-read", "reading", "finished"].entries()) {
    await storage.exec("INSERT INTO reading_list VALUES (?, 'pl', ?, ?, ?)", documents[index]!, status, AT, AT);
  }
  await user.setPosition(documents[1]!, { sentence: 9, token: 2, at: AT });
  await user.migrate(LATEST);
  const lists = await user.readingLists();
  assert.equal(lists.length, 3);
  for (const [index, name] of ["To read", "Reading now", "Finished"].entries()) {
    const list = lists.find((item) => item.name === name);
    assert.ok(list);
    assert.equal(list.documentsCount, 1);
    const page = await user.readingListDocuments(list.id, "pl", { limit: 10 });
    assert.deepEqual(
      page?.items.map((item) => [item.documentId, item.createdAt]),
      [[documents[index], AT]],
    );
    assert.deepEqual(await user.readingListMemberships(documents[index]!), [list.id]);
  }
  const position = await user.position(documents[1]!);
  assert.equal(position?.sentence, 9);
  assert.equal(position?.token, 2);
  assert.equal(position?.at, AT);
  assert.ok(!(await tables("reading-lists-migration")).includes("legacy_reading_list"));
  const toRead = schemas.ReadingListId.parse(1);
  const id = await user.createReadingList("Stories", AT);
  assert.equal(id, 4);
  assert.ok(id);
  assert.equal(await user.addDocumentToReadingList(id, documents[0]!, "pl", AT), true);
  assert.equal(await user.addDocumentToReadingList(id, documents[0]!, "pl", AT), true);
  assert.equal((await user.readingLists()).find((list) => list.id === id)?.documentsCount, 1);
  assert.equal(await user.deleteReadingList(id), true);
  assert.deepEqual(await user.readingListMemberships(documents[0]!), [toRead]);
  assert.equal(await user.renameReadingList(toRead, "Later"), true);
  assert.equal((await user.readingLists()).find((list) => list.id === toRead)?.name, "Later");
  assert.deepEqual(await user.readingListMemberships(documents[0]!), [toRead]);
  await user.migrate(1);
  assert.equal((await storage.exec("SELECT document_id FROM reading_list")).length, 3);
});

test("reading list pages seek an index, with language and cursor, without sorting", async () => {
  await local.env.USER.getByName("reading-lists-plan").settings();
  const storage = await storageOf("reading-lists-plan");
  for (const lang of [undefined, "pl"] as const) {
    for (const after of [undefined, schemas.ReadingKey.parse([AT, "0".repeat(64)])]) {
      const query = readingListDocumentsQuery(schemas.ReadingListId.parse(1), lang, { after, limit: 3 }).sql;
      const plan = (await storage.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query.text}`, ...query.params)).map((row) => row.detail);
      const index = lang ? "reading_list_document_lang" : "reading_list_document_page";
      assert.ok(plan.length === 1 && plan[0]!.startsWith(`SEARCH reading_list_document USING COVERING INDEX ${index} `), plan.join("; "));
    }
  }
});

test("reading lists are capped, and deleting one releases its slot", async () => {
  const user = local.env.USER.getByName("reading-lists-limit");
  for (let id = 4; id <= 200; id++) assert.equal(await user.createReadingList("List", AT), id);
  assert.equal(await user.createReadingList("Too many", AT), null);
  assert.equal((await user.readingLists()).length, 200);
  assert.equal(await user.deleteReadingList(schemas.ReadingListId.parse(200)), true);
  assert.equal(await user.createReadingList("Room again", AT), 201);
});

test("a page of cards seeks to its key in an index, in a language, a word or a text, and sorts nothing", async () => {
  await local.env.USER.getByName("ivan").settings();
  const storage = await storageOf("ivan");
  const newest = schemas.NewestCardKey.parse(["2026-11-07T00:00:00.000Z", "00000000-0000-4000-8000-000000000000"]);
  const listings = [false, true].flatMap((after) => [
    { index: "card USING INDEX card_listed", listing: { lang: "pl" as const, after: after ? newest : undefined, limit: 3 } },
    {
      index: "card_word USING COVERING INDEX card_word_listed",
      listing: { lemmaId: "pl:pies:NOUN" as const, after: after ? newest : undefined, limit: 3 },
    },
    {
      index: "card USING INDEX card_blank",
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
    assert.ok(plan[0]?.startsWith(`SEARCH ${index} `), why);
    assert.deepEqual(unseeked(plan), [], why);
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

test("a card's counts of its words not started and being learnt match its words, whatever happens to them", async () => {
  const at = schemas.Timestamp.parse("2026-11-07T00:00:00.000Z");
  const later = schemas.Timestamp.parse("2026-11-08T00:00:00.000Z");
  const user = local.env.USER.getByName("counted");
  const storage = await storageOf("counted");
  const made = async (lemmaId: "pl:pies:NOUN" | "pl:kot:NOUN" | "pl:dom:NOUN", kind: "recognition" | "production") => {
    const outcome = await user.makeCard({ kind, lemmaId, data: {} }, at);
    assert.ok(outcome.kind === "made");
    return outcome.cardId;
  };
  const kept = () =>
    storage.exec<{ id: string; unstarted: number; learning: number }>(
      "select id, unstarted_words as unstarted, learning_words as learning from card order by id",
    );
  const actual = () =>
    storage.exec<{ id: string; unstarted: number; learning: number }>(
      `select card.id, count(word.started_at is null or null) as unstarted, count(word.state = 'learning' or null) as learning
       from card left join card_word on card_word.card_id = card.id left join word on word.lemma_id = card_word.lemma_id
       group by card.id order by card.id`,
    );
  const pies = await made("pl:pies:NOUN", "production");
  await made("pl:pies:NOUN", "recognition");
  const kot = await made("pl:kot:NOUN", "recognition");
  await made("pl:dom:NOUN", "recognition");
  // A card of two words, as a sentence's might be
  await storage.exec("insert into card_word (card_id, lemma_id, kind, created_at) values (?, 'pl:kot:NOUN', 'production', ?)", pies, at);
  assert.deepEqual(await kept(), await actual());
  await user.review({ id: schemas.ReviewId.parse(crypto.randomUUID()), cardId: kot, rating: 3, at: later }, later);
  assert.deepEqual(await kept(), await actual());
  assert.ok(await user.setWordState("pl:pies:NOUN", "known"));
  assert.ok(await user.setWordState("pl:pies:NOUN", "known"));
  assert.deepEqual(await kept(), await actual());
  assert.ok(await user.setWordState("pl:kot:NOUN", "known"));
  assert.deepEqual(await kept(), await actual());
  assert.ok(await user.setWordState("pl:pies:NOUN", "learning"));
  await storage.exec("delete from card_word where card_id = ? and lemma_id = 'pl:kot:NOUN'", pies);
  assert.deepEqual(await kept(), await actual());
  assert.ok(await user.deleteCard(kot));
  await user.review({ id: schemas.ReviewId.parse(crypto.randomUUID()), cardId: pies, rating: 1, at: later }, later);
  assert.deepEqual(await kept(), await actual());
  // Words stay with their last card gone, and keep their counts of cards
  assert.deepEqual(await storage.exec("select lemma_id, state, started_at is not null as started, cards from word order by lemma_id"), [
    { lemma_id: "pl:dom:NOUN", state: "learning", started: 0, cards: 1 },
    { lemma_id: "pl:kot:NOUN", state: "known", started: 1, cards: 0 },
    { lemma_id: "pl:pies:NOUN", state: "learning", started: 1, cards: 2 },
  ]);
});

/** 5,000 words, each with a recognition, a production and a cloze card; the first 100 started,
 * the last 100 known. */
const MANY_WORDS = `
WITH RECURSIVE n (i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 4999)
INSERT INTO word (lemma_id, added_at, state)
  SELECT printf('pl:w%05d:NOUN', i), strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || i || ' seconds'), 'learning' FROM n;
INSERT INTO card (id, lang, kind, created_at, fsrs, data)
  SELECT word.lemma_id || ' ' || kind.name, 'pl', kind.name, word.added_at,
    json_object('dueAt', word.added_at, 'scheduleStatus', 'new', 'scheduledDays', 0),
    CASE kind.name WHEN 'cloze' THEN json_object('documentId', word.lemma_id, 'blankStart', 0) ELSE '{}' END
  FROM word, (SELECT 'recognition' AS name UNION ALL SELECT 'production' UNION ALL SELECT 'cloze') AS kind;
INSERT INTO card_word (card_id, lemma_id, kind, created_at)
  SELECT id, substr(id, 1, instr(id, ' ') - 1), kind, created_at FROM card;
UPDATE word SET started_at = '2026-01-02T00:00:00.000Z' WHERE lemma_id < 'pl:w00100';
UPDATE word SET state = 'known' WHERE lemma_id >= 'pl:w04900';
`;

test("choosing what to review seeks indexes, with 5,000 words", async () => {
  await local.env.USER.getByName("many").settings();
  const storage = await storageOf("many");
  await storage.exec(MANY_WORDS);
  const now = schemas.Timestamp.parse("2026-11-07T00:00:00.000Z");
  const lemmaId = schemas.LemmaId.parse("pl:w00200:NOUN");
  const checks = [
    { query: queries.dueQuery("pl", now, 200), seeks: ["card USING INDEX card_due"], sorts: false },
    { query: queries.dueCountQuery("pl", now), seeks: ["card USING INDEX card_due"], sorts: false },
    { query: queries.startedSinceQuery("pl", now), seeks: ["word USING INDEX word_started"], sorts: false },
    { query: queries.wordCardQuery(lemmaId, "recognition"), seeks: ["card_word USING COVERING INDEX card_word_kind"], sorts: false },
    {
      query: queries.startQuery(schemas.CardId.parse(crypto.randomUUID()), now),
      seeks: ["words USING COVERING INDEX card_word_card"],
      sorts: false,
    },
    // The new cards sort only what they've chosen: at most limit ready, and the picked words' cards
    ...[queries.freshQuery("pl", 20, 200), queries.freshCountQuery("pl", 20)].map((query) => ({
      query,
      seeks: [
        "card USING INDEX card_ready",
        "word USING INDEX word_unstarted",
        "brought USING COVERING INDEX card_word_listed",
        "mine USING COVERING INDEX card_word_card",
      ],
      sorts: true,
    })),
  ];
  for (const { query, seeks, sorts } of checks) {
    const plan = (await storage.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query.text}`, ...query.params)).map((row) => row.detail);
    const why = `${query.text}: ${plan.join("; ")}`;
    for (const index of seeks)
      assert.ok(
        plan.some((d) => d.startsWith(`SEARCH ${index} `)),
        why,
      );
    assert.deepEqual(
      unseeked(plan).filter((d) => !(sorts && d.includes("TEMP B-TREE"))),
      [],
      why,
    );
  }
  const fresh = queries.freshCountQuery("pl", 20);
  // The 100 started words' cards, and the next 20 words'
  assert.deepEqual(await storage.exec(fresh.text, ...fresh.params), [{ n: (100 + 20) * 3 }]);
});
