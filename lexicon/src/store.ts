import * as z from "zod";
import { LANGS, UPOS, langOf, type FeatureSets, type Lang, type LemmaId, type Lookup } from "@skolia/shared/api";
import type { Entry, Relation, Upos } from "@skolia/shared/schema";
import { sql, type Sql } from "@skolia/util/sql";
import { prepare } from "@skolia/util/d1";
import * as schemas from "@skolia/shared/schemas";
import {
  MAX_HOMOGRAPHS,
  MAX_INCOMING,
  NOTHING_MORE,
  type FormAudio,
  type Found,
  type Include,
  type Incoming,
  type Lexicon,
} from "./ports.ts";

const EntryRow = z.object({ data: z.string() });

const IncomingRow = z.object({
  sourceId: schemas.LemmaId,
  sourceLemma: z.string(),
  kind: z.string(),
  data: z.string(),
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

const CLOSEST_UPOS: Partial<Record<Upos, readonly Upos[]>> = {
  AUX: ["VERB"],
  PROPN: ["NOUN"],
  NOUN: ["PROPN"],
  DET: ["PRON", "ADJ"],
  PRON: ["DET"],
  PART: ["ADV"],
};

const Candidate = z.object({ lemma_id: schemas.LemmaId, upos: z.enum(UPOS), sense_count: z.number() });

const NONE: Found = { entries: [], related: [], incoming: new Map(), featureSets: null };

/** Which entries to look up: by id, or every entry with the spelling. */
type Selector = { readonly ids: readonly LemmaId[] } | { readonly lemma: string };

/** Each language's lexicon database, loaded by infra/load-lexicon.py from the same build
 * as the offline lexicon. Its JSON is ours, so it's trusted to match. It's only written when
 * a new build is loaded, so a session can start at any replica (first-unconstrained). A
 * load that switches versions during a lookup leaves the old version's rows until it
 * cleans up. */
export class D1Lexicon implements Lexicon {
  private readonly dbs: Record<Lang, D1DatabaseSession>;

  constructor(dbs: Record<Lang, D1Database>, constraint: D1SessionConstraint = "first-unconstrained") {
    this.dbs = Object.fromEntries(LANGS.map((lang) => [lang, dbs[lang].withSession(constraint)])) as Record<Lang, D1DatabaseSession>;
  }

  async served(lang: Lang): Promise<string | null> {
    const row = await prepare(this.dbs[lang], QUERIES.served()).first();
    return row === null ? null : LoadedRow.parse(row).version;
  }

  async byIds(lang: Lang, version: string, ids: readonly LemmaId[], include: Include): Promise<Found> {
    return await this.#find(this.dbs[lang], version, { ids }, include);
  }

  async formAudio(lang: Lang, version: string, form: string, upos: Upos): Promise<FormAudio> {
    const db = this.dbs[lang];
    const spellings = [...new Set([form, form.toLowerCase()])];
    const { results } = await prepare(db, QUERIES.formAudio(version, spellings)).all<{ form: string; upos: string; data: string }>();
    const rows = spellings.map(
      (spelling) => new Map(results.filter((row) => row.form === spelling).map((row) => [row.upos, JSON.parse(row.data) as FormAudio])),
    );
    function find(field: keyof FormAudio): FormAudio | undefined {
      for (const byPos of rows) {
        for (const pos of [upos, ...(CLOSEST_UPOS[upos] ?? [])]) {
          const audio = byPos.get(pos);
          if (audio?.[field].length) return audio;
        }
      }
      for (const byPos of rows) {
        for (const [pos, audio] of byPos) {
          if (pos !== "" && audio[field].length) return audio;
        }
      }
    }
    const spoken = find("pronunciations");
    const heard = (spoken ?? find("recordings"))?.recordings ?? [];
    return {
      pronunciations: spoken?.pronunciations ?? [],
      recordings: heard.length ? heard : (rows.map((byPos) => byPos.get("")?.recordings).find((audio) => audio?.length) ?? []),
    };
  }

  async resolve(lang: Lang, version: string, id: LemmaId, include: Include): Promise<Found> {
    const exact = await this.byIds(lang, version, [id], include);
    if (exact.entries.length > 0) return exact;

    const db = this.dbs[lang];
    const last = id.lastIndexOf(":");
    const lemma = id.slice(lang.length + 1, last);
    const upos = z.enum(UPOS).parse(id.slice(last + 1));
    const lower = lemma.toLowerCase();
    if (lower !== lemma) {
      const loweredId = schemas.LemmaId.safeParse(`${lang}:${lower}:${upos}`).data;
      if (loweredId !== undefined && (await prepare(db, QUERIES.withSenses(version, loweredId)).first()) !== null) {
        return this.byIds(lang, version, [loweredId], include);
      }
    }

    const { results } = await prepare(db, QUERIES.candidates(version, lemma)).all();
    const candidates = results.map((row) => Candidate.parse(row));
    const closest = CLOSEST_UPOS[upos] ?? [];
    const preferred = closest.map((pos) => candidates.find((row) => row.upos === pos)).find((row) => row !== undefined);
    const fallback = preferred ?? candidates[0];
    if (fallback !== undefined) return this.byIds(lang, version, [fallback.lemma_id], include);
    if (lower === lemma) return NONE;

    const row = await prepare(db, QUERIES.lowercase(version, lower)).first();
    return row === null ? NONE : this.byIds(lang, version, [schemas.LemmaId.parse(row.lemma_id)], include);
  }

  async byLemma(lang: Lang, version: string, lemma: string, include: Include): Promise<Found> {
    return await this.#find(this.dbs[lang], version, { lemma }, include);
  }

  /** What the API's cards show: the entries, each language's from the version it serves.
   * Ids it doesn't have are left out. */
  async entries(ids: readonly LemmaId[]): Promise<Lookup> {
    const found = await Promise.all(
      LANGS.map(async (lang) => {
        const wanted = ids.filter((id) => langOf(id) === lang);
        const version = wanted.length === 0 ? null : await this.served(lang);
        return { lang, ...(version === null ? NONE : await this.byIds(lang, version, wanted, NOTHING_MORE)) };
      }),
    );
    return {
      entries: found.flatMap((f) => f.entries),
      featureSets: Object.fromEntries(found.flatMap((f) => (f.featureSets === null ? [] : [[f.lang, f.featureSets]]))),
    };
  }

  async #find(db: D1DatabaseSession, version: string, selector: Selector, include: Include): Promise<Found> {
    const asked = await entriesOf(db, version, selector);
    if (asked.length === 0) return NONE;
    const have = new Set(asked.map((e) => e.lemma_id));
    const targetIds = include.related
      ? [
          ...new Set(
            asked
              .flatMap((e) => e.relations.flatMap((r) => (r.lemma_id === undefined ? [] : [schemas.LemmaId.parse(r.lemma_id)])))
              .filter((id) => !have.has(id)),
          ),
        ]
      : [];
    const [related, incoming] = await Promise.all([
      targetIds.length === 0 ? [] : entriesOf(db, version, { ids: targetIds }),
      include.incoming
        ? incomingOf(
            db,
            version,
            [...have].map((id) => schemas.LemmaId.parse(id)),
          )
        : new Map<LemmaId, Incoming>(),
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
    sql`(SELECT lemma_id FROM entry WHERE lemma = ${lemma} AND version = ${version}
       ORDER BY lemma_id LIMIT ${MAX_HOMOGRAPHS})`,
  formAudio: (version: string, forms: readonly string[]) =>
    sql`SELECT form, upos, data FROM form_pronunciation WHERE form IN ${sql.tuple(forms)} AND version = ${version}
        ORDER BY form, upos`,
  withSenses: (version: string, id: LemmaId) =>
    sql`SELECT lemma_id FROM entry WHERE lemma_id = ${id} AND version = ${version} AND sense_count > 0`,
  candidates: (version: string, lemma: string) =>
    sql`SELECT lemma_id, upos, sense_count FROM entry WHERE lemma = ${lemma} AND version = ${version}
        AND sense_count > 0 ORDER BY sense_count DESC, lemma_id LIMIT ${MAX_HOMOGRAPHS}`,
  lowercase: (version: string, lemma: string) =>
    sql`SELECT lemma_id FROM entry WHERE lemma_lower = ${lemma} AND version = ${version}
        AND sense_count > 0 ORDER BY sense_count DESC, lemma_id LIMIT 1`,
  /** The entries, each whole, as lexicon/entry.py built it. */
  entries: (version: string, ids: Sql) => sql`SELECT data FROM entry WHERE version = ${version} AND lemma_id IN ${ids} ORDER BY lemma_id`,
  /** The relations pointing at an entry, MAX_INCOMING and one more: relation_target. */
  incoming: (version: string, id: string) =>
    sql`SELECT relation.source_id AS sourceId, source.lemma AS sourceLemma, relation.kind, relation.data
       FROM relation
       JOIN entry AS source ON source.lemma_id = relation.source_id AND source.version = relation.version
       WHERE relation.target_id = ${id} AND relation.version = ${version}
       ORDER BY relation.source_id LIMIT ${MAX_INCOMING + 1}`,
  featureSets: (version: string, ids: readonly number[]) =>
    sql`SELECT id, feature, value FROM featureset WHERE version = ${version} AND id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
  served: () => sql`SELECT version FROM loaded`,
};

/** The selector's entries of version, by id. */
async function entriesOf(db: D1DatabaseSession, version: string, selector: Selector): Promise<Entry[]> {
  const { results } = await prepare(db, QUERIES.entries(version, idsOf(version, selector))).all();
  return results.map((row) => JSON.parse(EntryRow.parse(row).data) as Entry);
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

/** An incoming relation, from its source: lemma and lemma_id are the source's, and the
 * rest is as the source has it (zgolić's derived-from golić is golić's incoming
 * derived-from zgolić, how: perfective). */
function incoming(edge: z.output<typeof IncomingRow>): Relation {
  return schemas.Relation.parse({
    ...(JSON.parse(edge.data) as object),
    kind: edge.kind,
    lemma: edge.sourceLemma,
    lemma_id: edge.sourceId,
  });
}
