import * as z from "zod";
import { LANGS, UPOS, langOf, type FeatureSets, type Lang, type LemmaId, type LexiconEntry, type Lookup } from "@skolia/shared/api";
import type { BundleParadigm, Pronunciation, Relation, Sense } from "@skolia/shared/schema";
import { sql, type Sql } from "@skolia/util/sql";
import type { Lexicon } from "../../ports/lexicon.ts";
import { prepare } from "@skolia/util/d1";
import * as schemas from "@skolia/shared/schemas";

const EntryRow = z.object({
  lemmaId: schemas.LemmaId,
  version: z.string(),
  lemma: z.string(),
  upos: z.enum(UPOS),
  senses: z.string(),
  pronunciations: z.string(),
  paradigms: z.string(),
});

const RelationRow = z.object({
  sourceId: schemas.LemmaId,
  targetId: z.string(),
  kind: schemas.RelationType,
  note: z.string().nullable(),
  targetSenses: z.string().nullable(),
  targetLemma: z.string(),
  targetUpos: z.enum(UPOS).nullable(),
});

const FeatureRow = z.object({ id: z.number().int(), feature: z.string(), value: z.string() });

/** Each language's lexicon database, skolia-lexicon-{lang}[-env], bound as LEXICON_{LANG}
 * (api/wrangler.jsonc). */
export type LexiconBindings = { [L in Lang as `LEXICON_${Uppercase<L>}`]: D1Database };

export function lexiconBinding(lang: Lang): keyof LexiconBindings {
  return `LEXICON_${lang.toUpperCase() as Uppercase<Lang>}`;
}

export function lexiconsOf(env: LexiconBindings): Record<Lang, D1Database> {
  return Object.fromEntries(LANGS.map((lang) => [lang, env[lexiconBinding(lang)]])) as Record<Lang, D1Database>;
}

type Found = { readonly version: string; readonly entries: readonly LexiconEntry[] };

/** Each language's lexicon database, loaded by infra/load-lexicon.py from the same build
 * as the ingest images, serving its loaded version. Its JSON is ours, so it's trusted to
 * match. It's only written when a new build is loaded, so a session can start at any
 * replica (first-unconstrained). */
export class D1Lexicon implements Lexicon {
  private readonly dbs: Record<Lang, D1DatabaseSession>;

  constructor(dbs: Record<Lang, D1Database>) {
    this.dbs = Object.fromEntries(LANGS.map((lang) => [lang, dbs[lang].withSession("first-unconstrained")])) as Record<
      Lang,
      D1DatabaseSession
    >;
  }

  async entries(ids: readonly LemmaId[]): Promise<Lookup> {
    const byLang = new Map<Lang, LemmaId[]>();
    for (const id of ids) byLang.set(langOf(id), [...(byLang.get(langOf(id)) ?? []), id]);
    const found = await Promise.all(
      [...byLang].map(async ([lang, wanted]) => ({ lang, ...(await this.#entries(this.dbs[lang], wanted)) })),
    );
    return {
      entries: found.flatMap((f) => f.entries),
      featureSets: Object.fromEntries(found.filter((f) => f.featureSets !== null).map((f) => [f.lang, f.featureSets])),
    };
  }

  /** The entries with their relations, the targets of the relations of those with no
   * senses (shared/lexicon.ts sensesOf), and the feature sets their paradigms use, all
   * from the version served when the first batch ran: a load that switches versions in
   * between leaves the old version's rows until it cleans up. */
  async #entries(db: D1DatabaseSession, ids: readonly LemmaId[]): Promise<{ entries: LexiconEntry[]; featureSets: FeatureSets | null }> {
    const asked = await nodes(db, ids, sql`(SELECT version FROM loaded)`);
    if (asked === null) return { entries: [], featureSets: null };
    const have = new Set(asked.entries.map((e) => e.lemmaId));
    const targetIds = [
      ...new Set(
        asked.entries
          .filter((e) => e.senses.length === 0)
          .flatMap((e) => e.relations.flatMap((r) => (r.lemma_id === undefined ? [] : [schemas.LemmaId.parse(r.lemma_id)])))
          .filter((id) => !have.has(id)),
      ),
    ];
    const targets = targetIds.length === 0 ? null : await nodes(db, targetIds, sql`${asked.version}`);
    const entries = [...asked.entries, ...(targets?.entries ?? [])];
    const used = new Set(entries.flatMap((e) => e.paradigms.flatMap((p) => p.forms.flatMap(([, sets]) => sets))));
    if (used.size === 0) return { entries, featureSets: null };
    const { results } = await prepare(
      db,
      sql`SELECT id, feature, value FROM featureset WHERE version = ${asked.version} AND id IN (SELECT value FROM json_each(${JSON.stringify([...used])}))`,
    ).all();
    // A UD feature set: its features are whatever the language's rows name
    const sets: Record<number, Record<string, string>> = {};
    for (const row of results) {
      const { id, feature, value } = FeatureRow.parse(row);
      (sets[id] ??= {})[feature] = value;
    }
    return { entries, featureSets: sets as FeatureSets };
  }
}

/** The entries of version (a value, or the subquery for the loaded one) with their
 * relations, in one batch so both see the same version. Null when none is found. */
async function nodes(db: D1DatabaseSession, ids: readonly LemmaId[], version: Sql): Promise<Found | null> {
  const [entryRows, relationRows] = await db.batch([
    prepare(
      db,
      sql`SELECT lemma_id AS lemmaId, version, lemma, upos, senses, pronunciations, paradigms
         FROM entry WHERE version = ${version} AND lemma_id IN ${sql.tuple(ids)} AND upos IS NOT NULL`,
    ),
    prepare(
      db,
      sql`SELECT relation.source_id AS sourceId, relation.target_id AS targetId, relation.kind,
           relation.note, relation.target_senses AS targetSenses, target.lemma AS targetLemma,
           target.upos AS targetUpos
         FROM relation
         JOIN entry AS target ON target.lemma_id = relation.target_id AND target.version = relation.version
         WHERE relation.version = ${version} AND relation.source_id IN ${sql.tuple(ids)}
         ORDER BY relation.source_id, relation.ord`,
    ),
  ]);
  const rows = (entryRows?.results ?? []).map((row) => EntryRow.parse(row));
  const first = rows[0];
  if (first === undefined) return null;
  const relations = new Map<LemmaId, Relation[]>();
  for (const row of relationRows?.results ?? []) {
    const { sourceId, ...edge } = RelationRow.parse(row);
    relations.set(sourceId, [...(relations.get(sourceId) ?? []), relation(edge)]);
  }
  return {
    version: first.version,
    entries: rows.map(({ version: _, senses, pronunciations, paradigms, ...rest }) => ({
      ...rest,
      senses: JSON.parse(senses) as Sense[],
      relations: relations.get(rest.lemmaId) ?? [],
      pronunciations: JSON.parse(pronunciations) as Pronunciation[],
      paradigms: JSON.parse(paradigms) as BundleParadigm[],
    })),
  };
}

function relation(edge: Omit<z.output<typeof RelationRow>, "sourceId">): Relation {
  return {
    type: edge.kind,
    lemma: edge.targetLemma,
    ...(edge.note === null ? {} : { note: edge.note }),
    ...(edge.targetUpos === null ? {} : { lemma_id: edge.targetId }),
    ...(edge.targetSenses === null ? {} : { sense_indexes: JSON.parse(edge.targetSenses) as number[] }),
  };
}
