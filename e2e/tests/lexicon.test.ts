import assert from "node:assert/strict";
import { test } from "node:test";
import { LANGS, lemmaParam } from "@skolia/shared/api";
import { body } from "@skolia/util/responses";
import { lexicon } from "./client.ts";
import { WORDS } from "./words.ts";

test("lexicon entries and paradigms, with their licence", async () => {
  for (const lang of LANGS) {
    const word = WORDS[lang];
    const api = lexicon();
    const about = await api.lexicons[":lang"].$get({ param: { lang } });
    assert.equal(about.headers.get("cache-control"), "no-store");
    const { version } = await body("about", Promise.resolve(about));
    assert.ok(version, `lexicon: no ${lang} version loaded`);
    const response = await api.entries[":id"].$get({ param: { id: lemmaParam(word) }, query: { version } });
    assert.match(response.headers.get("link") ?? "", /rel="license"/);
    assert.ok(response.headers.get("etag"));
    const {
      entries: [entry],
      featureSets,
    } = await body("lexicon", Promise.resolve(response));
    assert.equal(entry?.lemma_id, word);
    if (!entry) throw new Error(`lexicon: no ${word}; has load-lexicon run?`);
    assert.ok(entry.senses.length > 0, `lexicon: ${word} has no senses`);
    assert.equal(entry.license.type, "CC-BY-SA-4.0");
    const used = entry.paradigms.flatMap((p) => p.forms.flatMap(([, ids]) => ids));
    assert.ok(used.length > 0, `lexicon: ${word} has no paradigm`);
    assert.deepEqual(
      used.filter((id) => featureSets[lang]?.[String(id)] === undefined),
      [],
      `lexicon: ${lang} feature sets missing`,
    );
  }
});
