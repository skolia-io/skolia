// Lexicon rows for tests, the lexicon's and the API's, written as infra/load-lexicon.py
// loads them.
import type { Lang, LemmaId } from "@skolia/shared/api";
import type { FormAudio } from "../ports.ts";
import type { StoredEntry } from "@skolia/shared/schema";
import { sql } from "@skolia/util/sql";
import { prepare } from "@skolia/util/d1";
import { lexiconsOf, type LexiconBindings } from "../store.ts";

export { lexiconBinding, lexiconsOf, type LexiconBindings } from "../store.ts";

/** An entry as the lexicon builds it, with what a test leaves out empty. */
export type TestEntry = Pick<StoredEntry, "lemma_id" | "lemma" | "upos"> & Partial<Omit<StoredEntry, "lemma_id" | "lemma" | "upos">>;

/** A test entry with one sense, the gloss. */
export function glossed(lemmaId: LemmaId, gloss: string, more: Partial<StoredEntry> = {}): TestEntry {
  const last = lemmaId.lastIndexOf(":");
  const lemma = lemmaId.slice(lemmaId.indexOf(":") + 1, last);
  const upos = lemmaId.slice(last + 1);
  return { lemma_id: lemmaId, lemma, upos: upos as StoredEntry["upos"], senses: [{ gloss, tags: [] }], ...more };
}

/** Loads a lexicon version with its feature sets, by id, and makes it the one served: each
 * entry whole, and its relations as rows. */
export async function loadLexicon(
  env: LexiconBindings,
  lang: Lang,
  version: string,
  entries: readonly TestEntry[],
  featureSets: readonly Record<string, string>[] = [],
): Promise<void> {
  const db = lexiconsOf(env)[lang];
  const whole = entries.map((e): StoredEntry => ({
    grammar: {},
    senses: [],
    relations: [],
    paradigms: [],
    frames: [],
    ...e,
  }));
  await db.batch([
    ...whole.map((e) =>
      prepare(
        db,
        sql`INSERT INTO entry (lemma_id, version, lemma, upos, data, lemma_lower, sense_count)
              VALUES ${sql.tuple([e.lemma_id, version, e.lemma, e.upos, JSON.stringify(e), e.lemma.toLowerCase(), e.senses.length])}`,
      ),
    ),
    ...whole.flatMap((e) =>
      e.relations.map(({ kind, lemma, lemma_id, ...data }, ord) =>
        prepare(
          db,
          sql`INSERT INTO relation (source_id, version, ord, target_lemma, target_id, kind, data) VALUES ${sql.tuple([
            e.lemma_id,
            version,
            ord,
            lemma,
            lemma_id ?? null,
            kind,
            JSON.stringify(data),
          ])}`,
        ),
      ),
    ),
    ...featureSets.flatMap((set, id) =>
      Object.entries(set).map(([feature, value]) =>
        prepare(db, sql`INSERT INTO featureset (version, id, feature, value) VALUES ${sql.tuple([version, id, feature, value])}`),
      ),
    ),
    prepare(db, sql`INSERT INTO loaded (id, version) VALUES (1, ${version}) ON CONFLICT (id) DO UPDATE SET version = excluded.version`),
  ]);
}

/** A spelling's audio, filed under a part of speech ("" for Commons' recordings of it). */
export type TestAudio = readonly [form: string, upos: string, audio: Partial<FormAudio>];

/** Files each spelling's audio in a lexicon version, as the build does. */
export async function loadAudio(env: LexiconBindings, lang: Lang, version: string, audio: readonly TestAudio[]): Promise<void> {
  const db = lexiconsOf(env)[lang];
  await db.batch(
    audio.map(([form, upos, { pronunciations = [], recordings = [] }]) =>
      prepare(
        db,
        sql`INSERT INTO form_pronunciation (form, upos, version, data)
              VALUES ${sql.tuple([form, upos, version, JSON.stringify({ pronunciations, recordings })])}`,
      ),
    ),
  );
}

/** Empties every language's lexicon. */
export async function clearLexicons(env: LexiconBindings): Promise<void> {
  for (const db of Object.values(lexiconsOf(env))) {
    await db.batch(
      ["entry", "relation", "featureset", "form_pronunciation", "loaded"].map((t) => prepare(db, sql`DELETE FROM ${sql.id(t)}`)),
    );
  }
}
