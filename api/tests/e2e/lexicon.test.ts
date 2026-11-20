import assert from "node:assert/strict";
import { test } from "node:test";
import { LANGS } from "@skolia/shared/api";
import { body } from "../../src/testing/responses.ts";
import { client } from "./client.ts";
import { WORDS } from "./words.ts";

test("lexicon entries and paradigms", async () => {
  const { entries, featureSets } = await body("lexicon", client().lexicon.entries.$post({ json: { ids: Object.values(WORDS) } }));
  for (const lang of LANGS) {
    const word = WORDS[lang];
    const entry = entries.find((e) => e.lemmaId === word);
    if (!entry) throw new Error(`lexicon: no ${word}; has load-lexicon run?`);
    assert.ok(entry.senses.length > 0, `lexicon: ${word} has no senses`);
    const used = entry.paradigms.flatMap((p) => p.forms.flatMap(([, ids]) => ids));
    assert.ok(used.length > 0, `lexicon: ${word} has no paradigm`);
    assert.deepEqual(
      used.filter((id) => featureSets[lang]?.[String(id)] === undefined),
      [],
      `lexicon: ${lang} feature sets missing`,
    );
  }
});
