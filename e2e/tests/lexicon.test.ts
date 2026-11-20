import assert from "node:assert/strict";
import { test } from "node:test";
import { LANGS } from "@skolia/shared/api";
import { body } from "@skolia/util/responses";
import { lexicon } from "./client.ts";
import { WORDS } from "./words.ts";

test("lexicon entries and paradigms, with their licence", async () => {
  const response = await lexicon().entries.$get({ query: { id: Object.values(WORDS) } });
  assert.match(response.headers.get("link") ?? "", /rel="license"/);
  const { entries, featureSets } = await body("lexicon", Promise.resolve(response));
  for (const lang of LANGS) {
    const word = WORDS[lang];
    const entry = entries.find((e) => e.lemmaId === word);
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
