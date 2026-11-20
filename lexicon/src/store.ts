import * as z from "zod";
import { LANGS, UPOS, langOf, type FeatureSets, type Lang, type LemmaId, type LexiconEntry, type Lookup } from "@skolia/shared/api";
import type { BundleParadigm, Pronunciation, Relation, Sense } from "@skolia/shared/schema";
import { sql, type Sql } from "@skolia/util/sql";
import { prepare } from "@skolia/util/d1";
import * as schemas from "@skolia/shared/schemas";
import { MAX_HOMOGRAPHS, MAX_INCOMING, NOTHING_MORE, type Found, type Include, type Incoming, type Lexicon } from "./ports.ts";

const EntryRow = z.object({
  lemmaId: schemas.LemmaId,
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

const IncomingRow = z.object({
  sourceId: schemas.LemmaId,
  sourceLemma: z.string(),
  kind: schemas.RelationType,
  note: z.string().nullable(),
  targetSenses: z.string().nullable(),
});

const FeatureRow = z.object({ id: z.number().int(), feature: z.string(), value: z.string() });

const LoadedRow = z.object({ version: z.string() });

/** Each language's lexicon database, skolia-lexicon-{lang}[-env], bound as LEXICON_{LANG}
 * (lexicon/wrangler.jsonc). */
export type LexiconBindings = { [L in Lang as `LEXICON_${Uppercase<L>}`]: D1Database };

export function lexiconBinding(lang: Lang): keyof LexiconBindings {
  return `LEXICON_${lang.toUpperCase() as Uppercase<Lang>}`;
}

export function lexiconsOf(env: LexiconBindings): Record<Lang, D1Database> {
  return Object.fromEntries(LANGS.map((lang) => [lang, env[lexiconBinding(lang)]])) as Record<Lang, D1Database>;
}

const NONE: Found = { entries: [], related: [], incoming: new Map(), featureSets: null };

/** Which entries to look up: by id, or every entry with the spelling. */
type Selector = { readonly ids: readonly LemmaId[] } | { readonly lemma: string };

/** Each language's lexicon database, loaded by infra/load-lexicon.py from the same build
 * as the ingest images. Its JSON is ours, so it's trusted to match. It's only written when
 * a new build is loaded, so a session can start at any replica (first-unconstrained). A
 * load that switches versions during a lookup leaves the old version's rows until it
 * cleans up. */
export class D1Lexicon implements Lexicon {
  private readonly dbs: Record<Lang, D1DatabaseSession>;

  constructor(dbs: Record<Lang, D1Database>) {
    this.dbs = Object.fromEntries(LANGS.map((lang) => [lang, dbs[lang].withSession("first-unconstrained")])) as Record<
      Lang,
      D1DatabaseSession
    >;
  }

  async served(lang: Lang): Promise<string | null> {
    const row = await prepare(this.dbs[lang], QUERIES.served()).first();
    return row === null ? null : LoadedRow.parse(row).version;
  }

  async byIds(lang: Lang, version: string, ids: readonly LemmaId[], include: Include): Promise<Found> {
    return await this.#find(this.dbs[lang], version, { ids }, include);
  }

  async byLemma(lang: Lang, version: string, lemma: string, include: Include): Promise<Found> {
    return await this.#find(this.dbs[lang], version, { lemma }, include);
  }

  /** What the API's cards show: the entries, each language's from the version it serves,
   * with the entries the relations of those with no senses point at, all in one list. Ids
   * it doesn't have are left out. */
  async entries(ids: readonly LemmaId[]): Promise<Lookup> {
    const found = await Promise.all(
      LANGS.map(async (lang) => {
        const wanted = ids.filter((id) => langOf(id) === lang);
        const version = wanted.length === 0 ? null : await this.served(lang);
        return { lang, ...(version === null ? NONE : await this.byIds(lang, version, wanted, NOTHING_MORE)) };
      }),
    );
    return {
      entries: found.flatMap((f) => [...f.entries, ...f.related]),
      featureSets: Object.fromEntries(found.flatMap((f) => (f.featureSets === null ? [] : [[f.lang, f.featureSets]]))),
    };
  }

  async #find(db: D1DatabaseSession, version: string, selector: Selector, include: Include): Promise<Found> {
    const asked = await nodes(db, version, selector);
    if (asked.length === 0) return NONE;
    const have = new Set(asked.map((e) => e.lemmaId));
    const targetIds = [
      ...new Set(
        asked
          .filter((e) => include.related || e.senses.length === 0)
          .flatMap((e) => e.relations.flatMap((r) => (r.lemma_id === undefined ? [] : [schemas.LemmaId.parse(r.lemma_id)])))
          .filter((id) => !have.has(id)),
      ),
    ];
    const [related, incoming] = await Promise.all([
      targetIds.length === 0 ? [] : nodes(db, version, { ids: targetIds }),
      include.incoming ? incomingOf(db, version, [...have]) : new Map<LemmaId, Incoming>(),
    ]);
    const used = new Set([...asked, ...related].flatMap((e) => e.paradigms.flatMap((p) => p.forms.flatMap(([, sets]) => sets))));
    return { entries: asked, related, incoming, featureSets: used.size === 0 ? null : await featureSets(db, version, used) };
  }
}

/** The feature sets of version with these ids. */
async function featureSets(db: D1DatabaseSession, version: string, ids: ReadonlySet<number>): Promise<FeatureSets> {
  const { results } = await prepare(db, QUERIES.featureSets(version, [...ids])).all();
  // A UD feature set: its features are whatever the language's rows name
  const sets: Record<number, Record<string, string>> = {};
  for (const row of results) {
    const { id, feature, value } = FeatureRow.parse(row);
    (sets[id] ??= {})[feature] = value;
  }
  return sets as FeatureSets;
}

/** The selector's entries' ids in version: a list, or a subquery that seeks entry_lemma. */
function idsOf(version: string, selector: Selector): Sql {
  return "ids" in selector ? sql.tuple(selector.ids) : QUERIES.spelt(version, selector.lemma);
}

/** The lexicon's queries, each a seek of an index (lexicon.workerd.test.ts checks their
 * plans). ids: a list, or the subquery spelt makes. */
export const QUERIES = {
  /** The ids of the entries spelt lemma, MAX_HOMOGRAPHS at most: entry_lemma. */
  spelt: (version: string, lemma: string) =>
    sql`(SELECT lemma_id FROM entry WHERE lemma = ${lemma} AND version = ${version} AND upos IS NOT NULL
       ORDER BY lemma_id LIMIT ${MAX_HOMOGRAPHS})`,
  entries: (version: string, ids: Sql) =>
    sql`SELECT lemma_id AS lemmaId, lemma, upos, senses, pronunciations, paradigms
       FROM entry WHERE version = ${version} AND lemma_id IN ${ids} AND upos IS NOT NULL
       ORDER BY lemma_id`,
  /** The entries' relations, with what they point at. */
  relations: (version: string, ids: Sql) =>
    sql`SELECT relation.source_id AS sourceId, relation.target_id AS targetId, relation.kind,
         relation.note, relation.target_senses AS targetSenses, target.lemma AS targetLemma,
         target.upos AS targetUpos
       FROM relation
       JOIN entry AS target ON target.lemma_id = relation.target_id AND target.version = relation.version
       WHERE relation.version = ${version} AND relation.source_id IN ${ids}
       ORDER BY relation.source_id, relation.ord`,
  /** The relations pointing at an entry, MAX_INCOMING and one more: relation_target. */
  incoming: (version: string, id: string) =>
    sql`SELECT relation.source_id AS sourceId, source.lemma AS sourceLemma, relation.kind,
         relation.note, relation.target_senses AS targetSenses
       FROM relation
       JOIN entry AS source ON source.lemma_id = relation.source_id AND source.version = relation.version
       WHERE relation.target_id = ${id} AND relation.version = ${version} AND source.upos IS NOT NULL
       ORDER BY relation.source_id LIMIT ${MAX_INCOMING + 1}`,
  featureSets: (version: string, ids: readonly number[]) =>
    sql`SELECT id, feature, value FROM featureset WHERE version = ${version} AND id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
  served: () => sql`SELECT version FROM loaded`,
};

/** The selector's entries of version with their relations, in one batch, by id. Spellings
 * with no entry (no upos) are left out. */
async function nodes(db: D1DatabaseSession, version: string, selector: Selector): Promise<LexiconEntry[]> {
  const ids = idsOf(version, selector);
  const [entryRows, relationRows] = await db.batch([
    prepare(db, QUERIES.entries(version, ids)),
    prepare(db, QUERIES.relations(version, ids)),
  ]);
  const relations = (relationRows?.results ?? []).map((row) => RelationRow.parse(row));
  return (entryRows?.results ?? []).map((row) => {
    const { senses, pronunciations, paradigms, ...rest } = EntryRow.parse(row);
    return {
      ...rest,
      senses: JSON.parse(senses) as Sense[],
      relations: relations.filter((edge) => edge.sourceId === rest.lemmaId).map(relation),
      pronunciations: JSON.parse(pronunciations) as Pronunciation[],
      paradigms: JSON.parse(paradigms) as BundleParadigm[],
    };
  });
}

function relation(edge: z.output<typeof RelationRow>): Relation {
  return {
    type: edge.kind,
    lemma: edge.targetLemma,
    ...(edge.note === null ? {} : { note: edge.note }),
    ...(edge.targetUpos === null ? {} : { lemma_id: edge.targetId }),
    ...(edge.targetSenses === null ? {} : { sense_indexes: JSON.parse(edge.targetSenses) as number[] }),
  };
}

/** The relations of version pointing at each entry, by source id, MAX_INCOMING at most:
 * one statement per entry, each a seek of relation_target that stops at its limit, so an
 * entry that thousands of words point at costs no more than one that few do. */
async function incomingOf(db: D1DatabaseSession, version: string, ids: readonly LemmaId[]): Promise<Map<LemmaId, Incoming>> {
  const results = await db.batch(ids.map((id) => prepare(db, QUERIES.incoming(version, id))));
  return new Map(
    ids.map((id, i) => {
      const rows = (results[i]?.results ?? []).map((row) => IncomingRow.parse(row));
      return [id, { relations: rows.slice(0, MAX_INCOMING).map(incoming), truncated: rows.length > MAX_INCOMING }];
    }),
  );
}

/** An incoming relation, from its source: lemma and lemma_id are the source's, and
 * sense_indexes the senses of the entry it points at. */
function incoming(edge: z.output<typeof IncomingRow>): Relation {
  return {
    type: edge.kind,
    lemma: edge.sourceLemma,
    lemma_id: edge.sourceId,
    ...(edge.note === null ? {} : { note: edge.note }),
    ...(edge.targetSenses === null ? {} : { sense_indexes: JSON.parse(edge.targetSenses) as number[] }),
  };
}
