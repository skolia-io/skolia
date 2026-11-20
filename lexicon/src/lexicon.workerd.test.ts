import assert from "node:assert/strict";
import { test } from "node:test";
import { lemmaParam, type LemmaId } from "@skolia/shared/api";
import { body, expectStatus } from "@skolia/util/responses";
import { compile } from "@skolia/util/query";
import { sql, type Sql } from "@skolia/util/sql";
import { LICENSE } from "./licence.ts";
import { MAX_INCOMING } from "./ports.ts";
import { QUERIES } from "./store.ts";
import { glossed, loadLexicon, type TestEntry } from "./testing/load.ts";
import { MemoryCache, client, env, setup, useLocal } from "./testing/local.ts";

useLocal();

const ZGOLIC: readonly TestEntry[] = [
  glossed("pl:zgolić:VERB", "to shave", {
    grammar: { Aspect: "Perf" },
    relations: [
      { kind: "derived-from", lemma: "golić", lemma_id: "pl:golić:VERB", how: "perfective" },
      { kind: "aspect-partner", lemma: "golnąć", aspect: "Perf" },
    ],
  }),
  glossed("pl:golić:VERB", "to shave"),
  glossed("pl:pies:NOUN", "dog", { relations: [{ kind: "derived-from", lemma: "golić", lemma_id: "pl:golić:VERB", how: "diminutive" }] }),
];

function lookUp(app: ReturnType<typeof setup>, ids: LemmaId[], include?: string) {
  return client(app).entries.$get({ query: { id: ids, ...(include === undefined ? {} : { include }) } });
}

test("entries come from each language's loaded version, without the ids it doesn't have", async () => {
  const app = setup();
  await loadLexicon(env, "pl", "lex/1", [glossed("pl:pies:NOUN", "dog (old)")]);
  await loadLexicon(env, "pl", "lex/1", [], [{ Case: "Nom" }, { Case: "Gen" }]);
  await loadLexicon(
    env,
    "pl",
    "lex/2",
    [
      glossed("pl:pies:NOUN", "dog", {
        pronunciations: [{ ipa: "/ˈpjɛs/" }],
        paradigms: [
          {
            homonym: "",
            forms: [
              ["pies", [0]],
              ["psa", [1, 2]],
            ],
          },
        ],
      }),
    ],
    [
      { Case: "Nom", Number: "Sing" },
      { Case: "Gen", Number: "Sing" },
      { Case: "Acc", Number: "Sing" },
      { Case: "Dat", Number: "Sing" },
    ],
  );
  await loadLexicon(env, "en", "lex/1", [glossed("en:dog:NOUN", "a domesticated canid")]);
  const { entries, related, featureSets } = await body("lookup", lookUp(app, ["pl:pies:NOUN", "en:dog:NOUN", "pl:kot:NOUN"]));
  assert.deepEqual(entries.map((e) => [e.lemma_id, e.senses[0]?.gloss]).sort(), [
    ["en:dog:NOUN", "a domesticated canid"],
    ["pl:pies:NOUN", "dog"],
  ]);
  assert.deepEqual(related, []);
  const pies = entries.find((e) => e.lemma_id === "pl:pies:NOUN");
  assert.deepEqual(pies?.pronunciations, [{ ipa: "/ˈpjɛs/" }]);
  assert.deepEqual(pies?.paradigms, [
    {
      homonym: "",
      forms: [
        ["pies", [0]],
        ["psa", [1, 2]],
      ],
    },
  ]);
  // Only the sets the paradigms use, from the served version; dog has no paradigm
  assert.deepEqual(featureSets, {
    pl: { "0": { Case: "Nom", Number: "Sing" }, "1": { Case: "Gen", Number: "Sing" }, "2": { Case: "Acc", Number: "Sing" } },
  });
});

test("an entry says its licence, whom to credit and its Wiktionary page, and every response links the licence", async () => {
  const app = setup();
  await loadLexicon(env, "pl", "lex/1", [glossed("pl:pies:NOUN", "dog")]);
  await loadLexicon(env, "en", "lex/1", [glossed("en:dog:NOUN", "a domesticated canid")]);
  const response = await lookUp(app, ["pl:pies:NOUN", "en:dog:NOUN"]);
  assert.equal(response.headers.get("link"), '<https://creativecommons.org/licenses/by-sa/4.0/>; rel="license"');
  const { entries } = await body("lookup", Promise.resolve(response));
  const pies = entries.find((e) => e.lemma_id === "pl:pies:NOUN");
  assert.deepEqual(pies?.license, LICENSE);
  assert.equal(pies?.sourceUrl, "https://en.wiktionary.org/wiki/pies#Polish");
  assert.deepEqual(
    pies?.attribution.map((a) => [a.title, a.url, a.license, a.provides]),
    [
      ["pies", "https://en.wiktionary.org/wiki/pies#Polish", "CC-BY-SA-4.0", "senses, relations and pronunciations"],
      ["Morfeusz 2 and the Grammatical Dictionary of Polish (SGJP)", "http://morfeusz.sgjp.pl", "BSD-2-Clause", "forms"],
    ],
  );
  const dog = entries.find((e) => e.lemma_id === "en:dog:NOUN");
  assert.deepEqual(
    dog?.attribution.map((a) => [a.author, a.url, a.via]),
    [["Wiktionary contributors", "https://en.wiktionary.org/wiki/dog#English", "https://kaikki.org"]],
  );
  const about = await body("about", client(app).lexicons[":lang"].$get({ param: { lang: "pl" } }));
  assert.deepEqual(about.license, LICENSE);
  assert.equal(about.version, "lex/1");
  assert.deepEqual(
    about.sources.map((s) => s.url),
    ["https://en.wiktionary.org", "http://morfeusz.sgjp.pl"],
  );
});

test("a language with no lexicon loaded has no version and no entries", async () => {
  const app = setup();
  assert.equal((await body("about", client(app).lexicons[":lang"].$get({ param: { lang: "fr" } }))).version, null);
  assert.deepEqual((await body("lookup", lookUp(app, ["fr:chien:NOUN"]))).entries, []);
});

test("a lookup takes 1 to 100 ids, and refuses ids that aren't one", async () => {
  const app = setup();
  const many = (n: number) => Array.from({ length: n }, (_, i): LemmaId => `pl:w${i}:NOUN`);
  await expectStatus("100 ids", lookUp(app, many(100)), 200);
  await expectStatus("101 ids", lookUp(app, many(101)), 400);
  await expectStatus("no ids", client(app).entries.$get({ query: { id: [] } }), 400);
  assert.equal((await app.request("http://lexicon.test/v1/entries?id=pies")).status, 400);
  await expectStatus("unknown include", lookUp(app, ["pl:pies:NOUN"], "everything"), 400);
});

test("an entry is served whole, as the lexicon built it; include=related brings what its relations point at", async () => {
  const app = setup();
  await loadLexicon(env, "pl", "lex/1", ZGOLIC);
  const plain = await body("lookup", lookUp(app, ["pl:zgolić:VERB"]));
  const [zgolic] = plain.entries;
  assert.deepEqual(zgolic?.grammar, { Aspect: "Perf" });
  assert.deepEqual(zgolic?.relations, ZGOLIC[0]?.relations);
  assert.deepEqual(plain.related, []);
  const related = await body("zgolić, related", lookUp(app, ["pl:zgolić:VERB"], "related"));
  assert.deepEqual(
    related.related.map((e) => e.lemma_id),
    ["pl:golić:VERB"],
  );
});

test("include=incoming gives the relations pointing at each entry, from their sources", async () => {
  const app = setup();
  await loadLexicon(env, "pl", "lex/1", ZGOLIC);
  const { entries } = await body(
    "golić",
    client(app).entries[":id"].$get({ param: { id: lemmaParam("pl:golić:VERB") }, query: { include: "incoming" } }),
  );
  const [golic] = entries;
  assert.deepEqual(golic?.incoming, [
    { kind: "derived-from", lemma: "pies", lemma_id: "pl:pies:NOUN", how: "diminutive" },
    { kind: "derived-from", lemma: "zgolić", lemma_id: "pl:zgolić:VERB", how: "perfective" },
  ]);
  assert.equal(golic?.incomingTruncated, false);
  const without = await body("golić", client(app).entries[":id"].$get({ param: { id: lemmaParam("pl:golić:VERB") }, query: {} }));
  assert.equal(without.entries[0]?.incoming, undefined);
});

test(`at most ${MAX_INCOMING} incoming relations come, by source id, and the entry says there are more`, async () => {
  const app = setup();
  const sources = Array.from(
    { length: MAX_INCOMING + 1 },
    (_, i): TestEntry =>
      glossed(`pl:w${String(i).padStart(3, "0")}:NOUN`, "a word", {
        relations: [{ kind: "derived-from", lemma: "golić", lemma_id: "pl:golić:VERB", how: "noun-from-verb" }],
      }),
  );
  await loadLexicon(env, "pl", "lex/1", [glossed("pl:golić:VERB", "to shave"), ...sources]);
  const { entries } = await body("golić", lookUp(app, ["pl:golić:VERB"], "incoming"));
  const incoming = entries[0]?.incoming ?? [];
  assert.equal(incoming.length, MAX_INCOMING);
  assert.equal(incoming[0]?.lemma_id, "pl:w000:NOUN");
  assert.equal(entries[0]?.incomingTruncated, true);
});

test("an entry by id, a lemma with a slash percent-encoded; 404 for one the lexicon hasn't", async () => {
  const app = setup();
  await loadLexicon(env, "pl", "lex/1", [glossed("pl:i/lub:CCONJ", "and/or")]);
  const { entries } = await body("i/lub", client(app).entries[":id"].$get({ param: { id: lemmaParam("pl:i/lub:CCONJ") }, query: {} }));
  assert.deepEqual(
    entries.map((e) => e.lemma_id),
    ["pl:i/lub:CCONJ"],
  );
  await expectStatus("kot", client(app).entries[":id"].$get({ param: { id: lemmaParam("pl:kot:NOUN") }, query: {} }), 404);
});

test("entries by spelling are the lemma's, one per part of speech; 404 for a spelling with none", async () => {
  const app = setup();
  await loadLexicon(env, "pl", "lex/1", [
    glossed("pl:zamek:NOUN", "castle; lock"),
    glossed("pl:zamek:PROPN", "a surname"),
    glossed("pl:zamknąć:VERB", "to close"),
  ]);
  const zamek = await body(
    "zamek",
    client(app).lexicons[":lang"].lemmas[":lemma"].$get({ param: { lang: "pl", lemma: "zamek" }, query: {} }),
  );
  assert.deepEqual(
    zamek.entries.map((e) => e.lemma_id),
    ["pl:zamek:NOUN", "pl:zamek:PROPN"],
  );
  await expectStatus(
    "en zamek",
    client(app).lexicons[":lang"].lemmas[":lemma"].$get({ param: { lang: "en", lemma: "zamek" }, query: {} }),
    404,
  );
});

test("a response's ETag is the versions it read: the same versions are 304, a new one isn't", async () => {
  const app = setup();
  await loadLexicon(env, "pl", "lex/1", [glossed("pl:pies:NOUN", "dog")]);
  const first = await lookUp(app, ["pl:pies:NOUN"]);
  const etag = first.headers.get("etag") ?? "";
  assert.equal(etag, '"pl@lex/1"');
  assert.match(first.headers.get("cache-control") ?? "", /public/);
  const again = await client(app, { "If-None-Match": etag }).entries.$get({ query: { id: ["pl:pies:NOUN"] } });
  assert.equal(again.status, 304);
  await loadLexicon(env, "pl", "lex/2", [glossed("pl:pies:NOUN", "hound")]);
  const changed = await client(app, { "If-None-Match": etag }).entries.$get({ query: { id: ["pl:pies:NOUN"] } });
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.get("etag"), '"pl@lex/2"');
});

test("the edge cache keeps a response under its versions and query, in any order", async () => {
  const cache = new MemoryCache();
  const app = setup(cache);
  await loadLexicon(env, "pl", "lex/1", [glossed("pl:pies:NOUN", "dog"), glossed("pl:kot:NOUN", "cat")]);
  await body("first", lookUp(app, ["pl:pies:NOUN", "pl:kot:NOUN"]));
  assert.equal(cache.kept.size, 1);
  // Rows of a loaded version don't change; this one is changed to see the cache answer
  await env.LEXICON_PL.prepare("UPDATE entry SET data = json_set(data, '$.senses', json('[]')) WHERE lemma_id = 'pl:pies:NOUN'").run();
  const cached = await body("ids the other way round", lookUp(app, ["pl:kot:NOUN", "pl:pies:NOUN"]));
  assert.deepEqual(
    cached.entries.map((e) => e.senses[0]?.gloss),
    ["cat", "dog"],
  );
  assert.equal(cache.kept.size, 1);
  await loadLexicon(env, "pl", "lex/2", [glossed("pl:pies:NOUN", "hound")]);
  const fresh = await body("new version", lookUp(app, ["pl:pies:NOUN", "pl:kot:NOUN"]));
  assert.deepEqual(
    fresh.entries.map((e) => e.senses[0]?.gloss),
    ["hound"],
  );
  assert.equal(cache.kept.size, 2);
});

test("anyone can read it, from any origin", async () => {
  const app = setup();
  const response = await client(app, { Origin: "https://example.com" }).lexicons[":lang"].$get({ param: { lang: "pl" } });
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("each lookup seeks an index, and none sorts rows the index doesn't give in order", async () => {
  const ids = sql.tuple(["pl:pies:NOUN", "pl:kot:NOUN"]);
  const queries: Record<string, Sql> = {
    spelt: sql`SELECT * FROM entry WHERE lemma_id IN ${QUERIES.spelt("v", "zamek")}`,
    entries: QUERIES.entries("v", ids),
    entriesSpelt: QUERIES.entries("v", QUERIES.spelt("v", "zamek")),
    incoming: QUERIES.incoming("v", "pl:golić:VERB"),
    featureSets: QUERIES.featureSets("v", [1, 2]),
  };
  const plans = await Promise.all(
    Object.entries(queries).map(async ([name, query]) => {
      const { text, params } = compile(query);
      const { results } = await env.LEXICON_PL.prepare(`EXPLAIN QUERY PLAN ${text}`)
        .bind(...params)
        .all<{ detail: string }>();
      return { name, plan: results.map((r) => r.detail) };
    }),
  );
  const wrong = plans.filter(({ plan }) =>
    plan.some((d) => /^SCAN (entry|relation|featureset|target|source)\b/u.test(d) || /USE TEMP B-TREE/u.test(d)),
  );
  assert.deepEqual(wrong, [], wrong.map(({ name, plan }) => `${name}: ${plan.join("; ")}`).join("\n"));
});
