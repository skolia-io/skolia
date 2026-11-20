// Lexicon rows for tests, the lexicon's and the API's, written as infra/load-lexicon.py
// loads them.
import type { Lang } from "@skolia/shared/api";
import { sql } from "@skolia/util/sql";
import { prepare } from "@skolia/util/d1";
import { lexiconsOf, type LexiconBindings } from "../store.ts";

export { lexiconBinding, lexiconsOf, type LexiconBindings } from "../store.ts";

/** An entry, as a row of entry and its rows of relation. */
export type TestEntry = {
  readonly lemmaId: string;
  readonly lemma: string;
  /** null: a spelling relations point at, with no entry */
  readonly upos: string | null;
  /** null: no senses */
  readonly gloss: string | null;
  readonly pronunciations?: readonly unknown[];
  /** Compact, as in D1: [{ homonym, forms: [["psa", [0, 1]]] }] */
  readonly paradigms?: readonly unknown[];
  readonly relations?: readonly {
    readonly kind: string;
    readonly targetId: string;
    readonly note?: string;
    readonly targetSenses?: readonly number[];
  }[];
};

/** Loads a lexicon version with its feature sets, by id, and makes it the one served. */
export async function loadLexicon(
  env: LexiconBindings,
  lang: Lang,
  version: string,
  entries: readonly TestEntry[],
  featureSets: readonly Record<string, string>[] = [],
): Promise<void> {
  const db = lexiconsOf(env)[lang];
  await db.batch([
    ...entries.map((e) =>
      prepare(
        db,
        sql`INSERT INTO entry (lemma_id, version, lemma, upos, senses, pronunciations, paradigms) VALUES ${sql.tuple([
          e.lemmaId,
          version,
          e.lemma,
          e.upos,
          JSON.stringify(e.gloss === null ? [] : [{ gloss: e.gloss, tags: [] }]),
          JSON.stringify(e.pronunciations ?? []),
          JSON.stringify(e.paradigms ?? []),
        ])}`,
      ),
    ),
    ...entries.flatMap((e) =>
      (e.relations ?? []).map((r, ord) =>
        prepare(
          db,
          sql`INSERT INTO relation (source_id, version, ord, target_id, kind, note, target_senses) VALUES ${sql.tuple([
            e.lemmaId,
            version,
            ord,
            r.targetId,
            r.kind,
            r.note ?? null,
            r.targetSenses === undefined ? null : JSON.stringify(r.targetSenses),
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

/** Empties every language's lexicon. */
export async function clearLexicons(env: LexiconBindings): Promise<void> {
  for (const db of Object.values(lexiconsOf(env))) {
    await db.batch(["entry", "relation", "featureset", "loaded"].map((t) => prepare(db, sql`DELETE FROM ${sql.id(t)}`)));
  }
}
