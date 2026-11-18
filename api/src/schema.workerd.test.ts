import assert from "node:assert/strict";
import { test } from "node:test";
import { type TableColumn, tableColumns, timestampNames } from "@skolia/util/checks";
import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "./auth.ts";
import { ALICE, local, useLocal } from "./testing/app.ts";
import { authConfig } from "./testing/harness.ts";
import { DOCUMENT_QUERIES } from "./worker/adapters.ts";
import { INGEST_QUERIES } from "@skolia/ingest/history";

useLocal();

test("the D1 migrations make every table and column Better Auth expects", async () => {
  const { toBeCreated, toBeAdded } = await getMigrations(authOptions(authConfig(local.env.DB)));
  assert.deepEqual(toBeCreated, []);
  assert.deepEqual(toBeAdded, []);
});

test("every D1 table is STRICT, and timestamps must be toISOString()'s", async () => {
  const { env } = local;
  const { results } = await env.DB.prepare(
    "select name, strict from pragma_table_list where schema = 'main' and name not like 'sqlite_%' and name not like '_cf_%' and name != 'd1_migrations' order by name",
  ).all();
  assert.deepEqual(
    results,
    [
      "account",
      "apikey",
      "attribution",
      "background_migration",
      "document",
      "document_status",
      "session",
      "tag",
      "user",
      "user_document",
      "user_document_annotation",
      "user_document_tag",
      "verification",
    ].map((name) => ({ name, strict: 1 })),
  );
  const user = await local.signUp(ALICE);
  const document = env.DB.prepare(`insert into document (id, lang, words) values (?, 'pl', ?)`);
  await document.bind("a", 1).run();
  await assert.rejects(document.bind("b", "many").run(), /cannot store TEXT/);
  const addAttribution = (licence: string, author: string | null = null, source: string | null = null) =>
    env.DB.prepare("insert into attribution (licence, author, source) values (?, ?, ?)").bind(licence, author, source).run();
  const cc0 = await attributionId("cc0");
  await addAttribution("cc-by-3.0", "A", "https://example.org");
  await assert.rejects(addAttribution("cc0"), /UNIQUE constraint failed/);
  await assert.rejects(addAttribution("cc-by-3.0", "A", "https://example.org"), /UNIQUE constraint failed/);
  await assert.rejects(addAttribution("mit"), /CHECK constraint failed/);
  await assert.rejects(addAttribution("cc-by"), /CHECK constraint failed/);
  await assert.rejects(addAttribution("cc-by-4.0", ""), /CHECK constraint failed/);
  await assert.rejects(addAttribution("cc-by-4.0", null, "ftp://x"), /CHECK constraint failed/);
  const entry = (
    document: string,
    visibility: string,
    {
      attribution = cc0,
      imported = "2026-11-07T00:00:00.000Z",
      owner = user.id,
    }: { attribution?: number; imported?: string; owner?: string } = {},
  ) =>
    env.DB.prepare(
      `insert or replace into user_document (user_id, document_id, title, imported_at, visibility, attribution_id) values (?, ?, 't', ?, ?, ?)`,
    )
      .bind(owner, document, imported, visibility, attribution)
      .run();
  await entry("a", "public");
  for (const imported of ["2026-11-07T00:00:00Z", "2026-11-07 00:00:00", "yesterday"]) {
    await assert.rejects(entry("a", "public", { imported }), /CHECK constraint failed/);
  }
  await assert.rejects(entry("missing", "public"), /FOREIGN KEY constraint failed/);
  await assert.rejects(entry("a", "public", { owner: "nobody" }), /FOREIGN KEY constraint failed/);
  await assert.rejects(entry("a", "public", { attribution: 99 }), /FOREIGN KEY constraint failed/);
  await assert.rejects(entry("a", "secret"), /CHECK constraint failed/);
  await entry("a", "public", { attribution: await attributionId("all-rights-reserved") });
  // Deleting a user takes their entries, and leaves the text
  await env.DB.prepare(`delete from "user" where "id" = ?`).bind(user.id).run();
  assert.equal(await env.DB.prepare("select 1 from user_document where document_id = 'a'").first(), null);
  assert.notEqual(await env.DB.prepare("select 1 from document where id = 'a'").first(), null);
});

test("a D1 column is a toISOString() timestamp exactly when its name ends in _at, Better Auth's tables aside", async () => {
  const query = tableColumns(["d1_migrations", "user", "session", "account", "verification", "apikey"]);
  const { results } = await local.env.DB.prepare(query.text)
    .bind(...query.params)
    .all<TableColumn>();
  assert.ok(results.some((c) => c.table === "user_document" && c.column === "imported_at"));
  assert.deepEqual(timestampNames(results), { unnamed: [], unchecked: [] });
});

/** The id of the attribution row for the licence, with no author or source, added if there's none. */
async function attributionId(licence: string): Promise<number> {
  await local.env.DB.prepare("insert into attribution (licence) values (?) on conflict do nothing").bind(licence).run();
  const row = await local.env.DB.prepare("select id from attribution where licence = ? and author is null and source is null")
    .bind(licence)
    .first<{ id: number }>();
  if (row === null) throw new Error(`no attribution row for ${licence}`);
  return row.id;
}

// A SCAN that names an index walks it in order, as list does over the public entries' partial index
test("no document query scans a whole table or sorts its rows", async () => {
  const plans = await Promise.all(
    Object.entries(DOCUMENT_QUERIES).map(async ([name, sql]) => {
      const { results } = await local.env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...Array.from({ length: parameters(sql) }, () => "x"))
        .all<{ detail: string }>();
      return { name, plan: results.map((r) => r.detail) };
    }),
  );
  // A list's page walks its indexes in the list's order; visible sorts one text's entries
  const paged = (name: string) => name.startsWith("list") || name.startsWith("tags");
  const wrong = plans.filter(({ name, plan }) =>
    plan.some((d) => /^SCAN \S+$/u.test(d) || (paged(name) && /USE TEMP B-TREE FOR .*ORDER BY/u.test(d))),
  );
  assert.deepEqual(wrong, [], wrong.map(({ name, plan }) => `${name}: ${plan.join("; ")}`).join("\n"));
});

test("the ingest history's queries seek its index", async () => {
  const plans = await Promise.all(
    Object.entries(INGEST_QUERIES).map(async ([name, sql]) => {
      const { results } = await local.env.INGEST_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...Array.from({ length: parameters(sql) }, () => "x"))
        .all<{ detail: string }>();
      return { name, plan: results.map((r) => r.detail) };
    }),
  );
  const wrong = plans.filter(({ plan }) => plan.some((d) => /^SCAN ingest_job$/u.test(d) || /USE TEMP B-TREE/u.test(d)));
  assert.deepEqual(wrong, [], wrong.map(({ name, plan }) => `${name}: ${plan.join("; ")}`).join("\n"));
});

test("a tag's kind and value are kind:value's, and each kind's tags have their own order", async () => {
  const add = (kind: string, value: string, position: number) =>
    local.env.DB.prepare("insert into tag (kind, value, description, position) values (?, ?, null, ?)").bind(kind, value, position).run();
  await add("form", "poem", 0);
  await add("form", "story", 1);
  await assert.rejects(add("form", "play", 1), /UNIQUE constraint failed/);
  for (const [kind, value] of [
    ["Form", "x"],
    ["form", ""],
    ["form", "a b"],
    ["form:x", "y"],
    ["-form", "y"],
    ["form", "-x"],
  ] as const) {
    await assert.rejects(add(kind, value, 9), /CHECK constraint failed/, `${kind}:${value}`);
  }
  await local.env.DB.prepare("delete from tag where kind = 'form'").run();
});

test("an entry's tags are tags skolia has, one of each kind, and go with the entry", async () => {
  const { env } = local;
  const user = await local.signUp(ALICE);
  await env.DB.prepare("insert into document (id, lang, words) values ('a', 'pl', 1)").run();
  await env.DB.prepare(
    `insert into user_document (user_id, document_id, title, imported_at, visibility, attribution_id) values (?, 'a', 't', '2026-11-07T00:00:00.000Z', 'public', ?)`,
  )
    .bind(user.id, await attributionId("cc0"))
    .run();
  const tag = (kind: string, value: string, document = "a") =>
    env.DB.prepare("insert into user_document_tag (user_id, document_id, kind, value) values (?, ?, ?, ?)")
      .bind(user.id, document, kind, value)
      .run();
  const { results: known } = await env.DB.prepare("select kind, value from tag").all<{ kind: string; value: string }>();
  for (const { kind, value } of known) {
    await tag(kind, value);
    await env.DB.prepare("delete from user_document_tag").run();
  }
  await assert.rejects(tag("level", "D1"), /FOREIGN KEY constraint failed/);
  await assert.rejects(tag("genre", "poem"), /FOREIGN KEY constraint failed/);
  await assert.rejects(tag("level", "A1", "missing"), /FOREIGN KEY constraint failed/);
  await tag("level", "A1");
  await assert.rejects(tag("level", "B1"), /UNIQUE constraint failed/);
  await env.DB.prepare("delete from user_document where document_id = 'a'").run();
  assert.equal(await env.DB.prepare("select 1 from user_document_tag").first(), null);
});

test("an annotation is a range of an entry's text, with JSON data and an attribution, counted on the entry, and goes with the entry", async () => {
  const { env } = local;
  const user = await local.signUp(ALICE);
  await env.DB.prepare("insert into document (id, lang, words) values ('a', 'pl', 1)").run();
  const unknown = await attributionId("unknown");
  const cc0 = await attributionId("cc0");
  await env.DB.prepare(
    `insert into user_document (user_id, document_id, title, imported_at, visibility, attribution_id) values (?, 'a', 't', '2026-11-07T00:00:00.000Z', 'private', ?)`,
  )
    .bind(user.id, unknown)
    .run();
  const audio = '{"url":"https://example.org/a.mp3"}';
  const annotate = ({
    document = "a",
    id = "x",
    start = 0,
    end = 1,
    kind = "audio",
    data = audio,
    attribution = cc0,
    addedAt = "2026-11-07T00:00:00.000Z",
  } = {}) =>
    env.DB.prepare("insert into user_document_annotation values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(user.id, document, id, start, end, kind, data, attribution, addedAt)
      .run();
  await annotate();
  await assert.rejects(annotate(), /UNIQUE constraint failed/);
  const bad = [
    { start: -1 },
    { start: 2, end: 2 },
    { start: 2, end: 1 },
    { data: "[]" },
    { data: "{" },
    { data: '"x"' },
    { addedAt: "2026-11-07T00:00:00Z" },
  ];
  for (const fields of bad) await assert.rejects(annotate({ id: "y", ...fields }), /CHECK constraint failed/, JSON.stringify(fields));
  await assert.rejects(annotate({ id: "y", document: "missing" }), /FOREIGN KEY constraint failed/);
  await assert.rejects(annotate({ id: "y", attribution: 99 }), /FOREIGN KEY constraint failed/);
  await annotate({ id: "y", data: '{ "url" : "https://example.org/b.mp3" }', attribution: unknown });
  await annotate({ id: "z", kind: "text", data: `{"text":"${"ż".repeat(2000)}"}` });
  const count = async () =>
    (await env.DB.prepare("select annotations_count from user_document where document_id = 'a'").first())?.["annotations_count"];
  assert.equal(await count(), 3);
  await env.DB.prepare("delete from user_document_annotation where id = 'y'").run();
  assert.equal(await count(), 2);
  await assert.rejects(
    env.DB.prepare("update user_document set annotations_count = -1 where document_id = 'a'").run(),
    /CHECK constraint failed/,
  );
  await env.DB.prepare("delete from user_document where document_id = 'a'").run();
  assert.equal(await env.DB.prepare("select 1 from user_document_annotation").first(), null);
});

test("a list narrowed by tags seeks each value from the cursor, and merges them", async () => {
  const sql = DOCUMENT_QUERIES.listTagged;
  const params = parameters(sql);
  const { results } = await local.env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...Array.from({ length: params }, () => "x"))
    .all<{ detail: string }>();
  const plan = results.map((r) => r.detail);
  const seeks = plan.filter((d) =>
    /^SEARCH tagged USING COVERING INDEX user_document_tag_value_idx \(kind=\? AND value=\? AND \(user_id,document_id\)>\(\?,\?\)\)$/u.test(
      d,
    ),
  );
  assert.equal(seeks.length, 2, plan.join("; "));
  assert.equal(plan[0], "MERGE (UNION ALL)", plan.join("; "));
});

/** How many parameters a query takes: its highest ?N, or its count of plain ?s. */
function parameters(sql: string): number {
  const numbered = [...sql.matchAll(/\?(\d+)/gu)].map((m) => Number(m[1]));
  return numbered.length > 0 ? Math.max(...numbered) : (sql.match(/\?/gu)?.length ?? 0);
}
