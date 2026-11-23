import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type TableColumn, tableColumns, timestampNames } from "@skolia/util/checks";
import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "./auth.ts";
import { ALICE, local, useLocal } from "./testing/app.ts";
import { authConfig, optimize } from "./testing/harness.ts";
import { CURATED_USER } from "./sync-curated-key.ts";
import { OPTIMIZE } from "@skolia/util/sqlite";
import { experimental_readRawConfig } from "wrangler";
import { CRONS } from "./worker/crons.ts";
import { DOCUMENT_QUERIES } from "./worker/adapters/document-queries.ts";
import { ROLE_QUERIES } from "./worker/adapters/roles.ts";
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
      "permission",
      "role",
      "role_binding",
      "role_permission",
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
  await entry("a", "public", { attribution: await attributionId("all-rights-reserved") });
  // Deleting a user takes their entries, and leaves the text
  await env.DB.prepare(`delete from "user" where "id" = ?`).bind(user.id).run();
  assert.equal(await env.DB.prepare("select 1 from user_document where document_id = 'a'").first(), null);
  assert.notEqual(await env.DB.prepare("select 1 from document where id = 'a'").first(), null);
});

test("the system role is seeded and bound to the seeded users; new roles and bindings need no schema change", async () => {
  const db = local.env.DB;
  assert.deepEqual((await db.prepare("SELECT name FROM role ORDER BY name").all()).results, [{ name: "system" }]);
  assert.deepEqual((await db.prepare("SELECT user_id, role FROM role_binding ORDER BY user_id").all()).results, [
    { user_id: "curated", role: "system" },
    { user_id: "system", role: "system" },
  ]);
  const user = await local.signUp(ALICE);
  const bind = (userId: string, role: string) =>
    db.prepare("INSERT INTO role_binding (user_id, role) VALUES (?, ?)").bind(userId, role).run();
  await assert.rejects(bind(user.id, "future"), /FOREIGN KEY constraint failed/);
  await assert.rejects(bind("nobody", "system"), /FOREIGN KEY constraint failed/);
  await db.prepare("INSERT INTO role VALUES ('future')").run();
  try {
    await bind(user.id, "future");
    await bind(user.id, "system");
    await assert.rejects(bind(user.id, "system"), /UNIQUE constraint failed/);
    await assert.rejects(db.prepare("DELETE FROM role WHERE name = 'future'").run(), /FOREIGN KEY constraint failed/);
    // Deleting a user takes their bindings
    await db.prepare(`DELETE FROM "user" WHERE "id" = ?`).bind(user.id).run();
    assert.deepEqual((await db.prepare("SELECT role FROM role_binding WHERE user_id = ?").bind(user.id).all()).results, []);
  } finally {
    await db.prepare("DELETE FROM role_binding WHERE role = 'future'").run();
    await db.prepare("DELETE FROM role WHERE name = 'future'").run();
  }
});

test("permissions are seeded, granted to roles, and new ones can be added without changing the schema", async () => {
  const db = local.env.DB;
  assert.deepEqual((await db.prepare("SELECT name FROM permission ORDER BY name").all()).results, [{ name: "unlimited-rate" }]);
  assert.deepEqual((await db.prepare("SELECT role, permission FROM role_permission ORDER BY role, permission").all()).results, [
    { role: "system", permission: "unlimited-rate" },
  ]);
  const grant = (role: string, permission: string) =>
    db.prepare("INSERT INTO role_permission (role, permission) VALUES (?, ?)").bind(role, permission).run();
  await assert.rejects(grant("nobody", "unlimited-rate"), /FOREIGN KEY constraint failed/);
  await assert.rejects(grant("system", "future"), /FOREIGN KEY constraint failed/);
  await assert.rejects(grant("system", "unlimited-rate"), /UNIQUE constraint failed/);
  await db.prepare("INSERT INTO permission (name, description) VALUES ('future', 'Something new')").run();
  try {
    await grant("system", "future");
    await assert.rejects(db.prepare("DELETE FROM permission WHERE name = 'future'").run(), /FOREIGN KEY constraint failed/);
  } finally {
    await db.prepare("DELETE FROM role_permission WHERE permission = 'future'").run();
    await db.prepare("DELETE FROM permission WHERE name = 'future'").run();
  }
});

test("a status may precede its document; the database checks structure, not app enum values", async () => {
  const db = local.env.DB;
  const at = "2026-11-07T00:00:00.000Z";
  const put = (id: string, state: string, updated: string, data: string) =>
    db
      .prepare("INSERT INTO document_status (document_id, state, updated_at, data) VALUES (?, ?, ?, ?)")
      .bind(id, state, updated, data)
      .run();
  await put("new-import", "queued", at, "{}");
  assert.equal(await db.prepare("SELECT * FROM document WHERE id = 'new-import'").first(), null);
  await put("future-state", "future", at, "{}");
  await assert.rejects(put("bad-date", "queued", "yesterday", "{}"), /CHECK constraint failed/);
  for (const data of ["[]", "null", "not json"]) await assert.rejects(put("bad-data", "queued", at, data));
  await db.prepare("INSERT INTO document VALUES ('new-lang', 'de', 1)").run();
  await assert.rejects(db.prepare("INSERT INTO document VALUES ('bad-words', 'pl', -1)").run(), /CHECK constraint failed/);
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

const USERS = 1000;
const CREDITS = 100;
/** Past the ids the other tests' credits take, which stay after a test */
const FIRST_CREDIT = 100_000;
/** Rows spread the way production's are, so that PRAGMA optimize gives the planner statistics
 * to choose by: users, each with a few texts of their own, some public, a curated library of
 * public texts with their tags and annotations, and credits for them. With a table of a
 * few rows, the planner would rather scan it than seek its index. */
async function seedDocuments(): Promise<void> {
  const { DB } = local.env;
  const user = await local.signUp(ALICE);
  const counted = (n: number) => `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${n - 1})`;
  await DB.batch([
    DB.prepare(
      `${counted(USERS)} INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       SELECT printf('u%d', i), 'u', printf('u%d@example.com', i), 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z' FROM n`,
    ),
    DB.prepare(
      `${counted(CREDITS)} INSERT OR IGNORE INTO attribution (id, licence, author) SELECT ${FIRST_CREDIT} + i, 'cc-by-4.0', printf('author %d', i) FROM n`,
    ),
    DB.prepare(
      `${counted(4000)} INSERT INTO document (id, lang, words)
       SELECT printf('%064d', i), CASE i % 3 WHEN 0 THEN 'en' WHEN 1 THEN 'fr' ELSE 'pl' END, 100 + i FROM n`,
    ),
    DB.prepare(
      `${counted(4000)} INSERT INTO user_document (user_id, document_id, title, imported_at, visibility, attribution_id)
       SELECT CASE WHEN i < 1000 THEN ?1 WHEN i < 2000 THEN ?2 ELSE printf('u%d', i % ?3) END, printf('%064d', i), 't',
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', printf('+%d minutes', i)), CASE WHEN i < 1000 OR i % 4 = 0 THEN 'public' ELSE 'private' END,
         ?4 + i % ?5
       FROM n`,
    ).bind(CURATED_USER, user.id, USERS, FIRST_CREDIT, CREDITS),
    DB.prepare(
      `INSERT INTO user_document_tag (user_id, document_id, kind, value)
       SELECT user_id, document_id, 'level', CASE substr(document_id, -1) WHEN '0' THEN 'A1' ELSE 'B1' END FROM user_document WHERE user_id = ?`,
    ).bind(CURATED_USER),
    DB.prepare(
      `${counted(4000)} INSERT INTO user_document_annotation (user_id, document_id, id, start, "end", kind, data, attribution_id, added_at)
       SELECT ?, printf('%064d', i / 20), printf('a%d', i), i % 20 * 10, i % 20 * 10 + 5, 'note', '{}', ?, '2026-01-01T00:00:00.000Z'
       FROM n`,
    ).bind(CURATED_USER, FIRST_CREDIT),
  ]);
  await optimize(DB);
  const analyzed = await DB.prepare("SELECT DISTINCT tbl FROM sqlite_stat1").all<{ tbl: string }>();
  for (const table of ["user", "attribution", "document", "user_document", "user_document_tag", "user_document_annotation"]) {
    assert.ok(
      analyzed.results.some((row) => row.tbl === table),
      table,
    );
  }
}

// A SCAN that names an index walks it in order, as list does over the public entries' partial index.
// With statistics, as PRAGMA optimize gives production's.
test("no document or role query scans a whole table or sorts its rows", async () => {
  await seedDocuments();
  const plans = await Promise.all(
    Object.entries({ ...DOCUMENT_QUERIES, ...ROLE_QUERIES }).map(async ([name, sql]) => {
      const { results } = await local.env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...Array.from({ length: parameters(sql) }, () => "x"))
        .all<{ detail: string }>();
      return { name, plan: results.map((r) => r.detail) };
    }),
  );
  // A list's page walks its indexes in the list's order; visible sorts one text's entries. A page
  // of tags may sort: tag holds the few rows migrations add, and with statistics SQLite sorts them
  // rather than look each one up from its (kind, position) index.
  const paged = (name: string) => name.startsWith("list");
  const wrong = plans.filter(({ name, plan }) =>
    plan.some((d) => /^SCAN \S+$/u.test(d) || (paged(name) && /USE TEMP B-TREE FOR .*ORDER BY/u.test(d))),
  );
  assert.deepEqual(wrong, [], wrong.map(({ name, plan }) => `${name}: ${plan.join("; ")}`).join("\n"));
});

test("just migrate optimizes both D1 databases as the tests do", () => {
  const justfile = readFileSync(new URL("../../justfile", import.meta.url).pathname, "utf8");
  const start = justfile.indexOf("\nmigrate env:");
  const migrate = justfile.slice(start, justfile.indexOf("\n\n", start)).split("\n");
  for (const db of ["DB", "INGEST_DB"]) {
    assert.ok(
      migrate.some((line) => line.includes(`d1 execute ${db} `) && line.includes(`--command "${OPTIMIZE.text}"`)),
      db,
    );
  }
});

test("wrangler.jsonc's cron triggers are CRONS, in order, in every environment", () => {
  const { rawConfig } = experimental_readRawConfig({ config: new URL("../wrangler.jsonc", import.meta.url).pathname });
  assert.deepEqual(rawConfig.triggers?.crons, [...CRONS]);
  for (const [name, env] of Object.entries(rawConfig.env ?? {}))
    assert.ok(typeof env === "object" && env !== null && !("triggers" in env), name);
});

/** The rows sqlite_stat1 has for user's primary key, and a way to add that many again, 20 times over */
function userStatistics() {
  const { DB } = local.env;
  const rows = async () => {
    const row = await DB.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = 'sqlite_autoindex_user_1'").first<{ stat: string }>();
    return Number(row?.stat.split(" ")[0]);
  };
  const grow = async () => {
    const n = (await rows()) * 20;
    await DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
       INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       SELECT printf('cron%d', i), 'u', printf('cron%d@example.com', i), 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z' FROM n`,
    )
      .bind(n)
      .run();
  };
  return { rows, grow };
}

const AT_THREE = new Date("2026-11-23T03:00:00Z");

test("the minute's cron runs the background migrations, and leaves D1's planner statistics", async () => {
  const stats = userStatistics();
  const before = await stats.rows();
  await stats.grow();
  const result = await local.server.getWorker().scheduled({ cron: "* * * * *", scheduledTime: AT_THREE });
  assert.equal(result.outcome, "ok");
  assert.equal(await stats.rows(), before);
});

test("the nightly cron brings D1's planner statistics up to date", async () => {
  const stats = userStatistics();
  await stats.grow();
  const result = await local.server.getWorker().scheduled({ cron: "0 3 * * *", scheduledTime: AT_THREE });
  assert.equal(result.outcome, "ok");
  const users = await local.env.DB.prepare('SELECT count(*) AS n FROM "user"').first<{ n: number }>();
  assert.equal(await stats.rows(), users?.n);
});

test("a cron the Worker has no handler for fails", async () => {
  const result = await local.server.getWorker().scheduled({ cron: "*/5 * * * *", scheduledTime: AT_THREE });
  assert.equal(result.outcome, "exception");
});

test("the ingest history's queries seek its index", async () => {
  await local.env.INGEST_DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 4999)
     INSERT INTO ingest_job (id, document_id, lang, image, accepted_at, started_at, finished_at, outcome, stages)
     SELECT printf('j%d', i), printf('%064d', i / 2), 'pl', 'i', t, t, t, 'ready', '[]'
     FROM (SELECT i, strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', printf('+%d minutes', i)) AS t FROM n)`,
  ).run();
  await optimize(local.env.INGEST_DB);
  const analyzed = await local.env.INGEST_DB.prepare("SELECT 1 FROM sqlite_stat1 WHERE tbl = 'ingest_job'").first();
  assert.notEqual(analyzed, null);
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
  await seedDocuments();
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
