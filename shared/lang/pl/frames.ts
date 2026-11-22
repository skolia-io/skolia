// Walenty valency schemata as the patterns Polish dictionaries print:
//   szukać kogoś/czegoś [gen.] w kimś/czymś [loc.]
//   bać się kogoś/czegoś [gen.]   ·   bać się, że …
// The indefinite pronoun is itself in the case, so the case shows twice: in the word
// and in the label.
import type {
  AdverbialCategory,
  Case,
  CaseSpec,
  Certainty,
  Complementizer,
  Deprel,
  Lex,
  LemmaChoice,
  Negation,
  Phrase,
  Position,
  Schema,
  Token,
  WhWord,
} from "@skolia/shared/schema";

export type Frame = {
  /** The pattern without the headword: "kogoś/czegoś [gen.] w kimś/czymś [loc.]". */
  readonly pattern: string;
  /** colloquial, archaic, vulgar, doubtful; "with nie" when only negated. */
  readonly tags: string[];
  /** Contains fixed words: an idiom (dać radę, mieć na oku). */
  readonly idiom: boolean;
  readonly reflexive: boolean;
  /** The sentence's own complements fit this frame. */
  readonly here: boolean;
};

/** How each case spec reads in a pattern, and which cases of the sentence fill it. */
type CaseForms = {
  /** A noun phrase: the pronoun plus the case label. */
  readonly nominal: string;
  /** The indefinite pronoun after a preposition: na kogoś/coś, w kimś/czymś. */
  readonly pronoun: string;
  /** "Some kind of", standing for an adjective: za jakiegoś, ku jakiemuś. */
  readonly adjective: string;
  readonly label: string;
  /** "to" in the case, for "tego, że ..." clauses. */
  readonly it: string;
  readonly fits: readonly Case[];
};

/** A case proper: who/what, someone/something in it, filled by that case alone. */
function inflected(pronoun: string, label: string, adjective: string, it: string, actual: Case): CaseForms {
  return { nominal: `${pronoun} [${label}]`, pronoun, adjective, label, it, fits: [actual] };
}

const CASES: Readonly<Record<CaseSpec, CaseForms>> = {
  nom: inflected("ktoś/coś", "nom.", "jakiś", "to", "Nom"),
  gen: inflected("kogoś/czegoś", "gen.", "jakiegoś", "tego", "Gen"),
  dat: inflected("komuś/czemuś", "dat.", "jakiemuś", "temu", "Dat"),
  acc: inflected("kogoś/coś", "acc.", "jakiegoś", "to", "Acc"),
  inst: inflected("kimś/czymś", "ins.", "jakimś", "tym", "Ins"),
  loc: inflected("kimś/czymś", "loc.", "jakimś", "tym", "Loc"),
  // accusative object, genitive when negated
  str: {
    nominal: "kogoś/coś [acc.; gen. with nie]",
    pronoun: "kogoś/coś",
    adjective: "jakiegoś",
    label: "acc.",
    it: "to",
    fits: ["Acc", "Gen"],
  },
  part: {
    nominal: "czegoś/coś [gen. some / acc. all]",
    pronoun: "…",
    adjective: "jakiś",
    label: "gen./acc.",
    it: "to",
    fits: ["Gen", "Acc"],
  },
  agr: { nominal: "[same case]", pronoun: "…", adjective: "jakiś", label: "same case", it: "to", fits: [] },
  pred: { nominal: "kimś/czymś [nom./ins.]", pronoun: "…", adjective: "jakiś", label: "nom./ins.", it: "to", fits: [] },
  postp: { nominal: "[po-form]", pronoun: "…", adjective: "jakiś", label: "po-form", it: "to", fits: [] },
};

const ADVERBIAL: Readonly<Record<AdverbialCategory, string>> = {
  locat: "gdzieś [where]",
  adl: "dokądś [where to]",
  abl: "skądś [where from]",
  perl: "którędyś [which way]",
  temp: "kiedyś [when]",
  dur: "jakiś czas [how long]",
  mod: "jakoś [how]",
  caus: "z jakiegoś powodu [why]",
  dest: "po coś [what for]",
  instr: "czymś [with what]",
  misc: "jakoś [adverb]",
  pron: "tak [adverb]",
};
const CERTAINTY_TAG: Readonly<Record<Certainty, string | null>> = {
  certain: null,
  doubtful: "doubtful",
  colloquial: "colloquial",
  archaic: "archaic",
  vulgar: "vulgar",
  wrong: "wrong",
};
const NEGATION_TAG: Readonly<Record<Negation, string | null>> = {
  any: null,
  neg: "with nie",
  aff: "without nie",
};

/** Complementizers that aren't the word a clause starts with: the word, and the clause as
 * a pattern on its own. */
const CLAUSE_START: Readonly<Partial<Record<Complementizer, { readonly word: string; readonly pattern: string }>>> = {
  int: { word: "czy", pattern: "czy/co/kto … [question]" },
  rel: { word: "który", pattern: "który/gdzie … [relative]" },
  żeby2: { word: "żeby", pattern: "żeby …" },
};

function clause(complementizer: Complementizer, words: readonly WhWord[]): string {
  if (words.length > 0) return `${words.join("/")} …`;
  return CLAUSE_START[complementizer]?.pattern ?? `${complementizer} …`;
}

/** The word a clause starts with: że, żeby, czy (indirect question), który (relative). */
function clauseWord(complementizer: Complementizer, words: readonly WhWord[]): string {
  if (words.length > 0) return words.join("/");
  return CLAUSE_START[complementizer]?.word ?? complementizer;
}

function lemmaList(choice: LemmaChoice): readonly string[] {
  return choice.kind === "one" ? [choice.lemma] : choice.lemmas;
}

function lemmas(choice: LemmaChoice): string {
  return lemmaList(choice).join(choice.kind === "or" ? ", " : "/");
}

type Kind = Phrase["kind"];
type PhraseOf<K extends Kind> = Phrase & { readonly kind: K };
type ByKind<R> = { readonly [K in Kind]: (phrase: PhraseOf<K>) => R };

const cased = (word: string) => (phrase: { readonly case: CaseSpec }) => `${word} [${CASES[phrase.case].label}]`;
const prepCased = (word: string) => (phrase: { readonly prep: string; readonly case: CaseSpec }) =>
  `${phrase.prep} ${word} [${CASES[phrase.case].label}]`;

/** A fixed word of an idiom in its phrase, with its preposition and case: "na oko [loc.]". */
const FIXED_WORD: Readonly<Partial<{ readonly [K in Kind]: (word: string) => (phrase: PhraseOf<K>) => string }>> = {
  np: cased,
  adjp: cased,
  nump: cased,
  prepnp: prepCased,
  prepadjp: prepCased,
  prepnump: prepCased,
  prepgerp: prepCased,
  prepppasp: prepCased,
};

function fixedWordIn<K extends Kind>(kind: K, phrase: PhraseOf<K>, word: string): string {
  return FIXED_WORD[kind]?.(word)(phrase) ?? word;
}

function fixedWord(lex: Lex): string {
  const phrase = lex.phrase.kind === "xp" ? (lex.phrase.realisations[0] ?? lex.phrase) : lex.phrase;
  return fixedWordIn(phrase.kind, phrase, lemmas(lex.lemmas));
}

const nominal = (phrase: { readonly case: CaseSpec }) => CASES[phrase.case].nominal;
const adjective = (phrase: { readonly case: CaseSpec }) =>
  phrase.case === "agr" ? "jakiś [adjective]" : `jakiś [adjective, ${CASES[phrase.case].label}]`;
const prepositional = (phrase: { readonly prep: string; readonly case: CaseSpec }) => prepCased(CASES[phrase.case].pronoun)(phrase);
const adverbial = (phrase: { readonly category: AdverbialCategory }) => ADVERBIAL[phrase.category];

const DESCRIPTION: ByKind<string> = {
  np: nominal,
  nump: nominal,
  adjp: adjective,
  ppasp: adjective,
  pactp: adjective,
  prepnp: prepositional,
  prepnump: prepositional,
  prepgerp: prepositional,
  prepppasp: prepositional,
  prepadjp: (phrase) =>
    phrase.case === "postp" ? `${phrase.prep} jakiemuś [adverb: po polsku]` : prepCased(CASES[phrase.case].adjective)(phrase),
  comprepnp: (phrase) => `${phrase.prep} …`,
  cp: (phrase) => clause(phrase.complementizer, phrase.words),
  ncp: (phrase) => `${CASES[phrase.case].it}, ${clause(phrase.complementizer, phrase.words)} [${CASES[phrase.case].label}]`,
  prepncp: (phrase) => `${phrase.prep} ${CASES[phrase.case].it}, ${clause(phrase.complementizer, phrase.words)}`,
  infp: () => "robić coś [infinitive]",
  xp: adverbial,
  advp: adverbial,
  compar: (phrase) => `${phrase.comparator} …`,
  fixed: (phrase) => `„${phrase.text}”`,
  lex: fixedWord,
  lexcompar: (phrase) => phrase.parts.map(fixedWord).join(" "),
  possp: () => "czyjś [possessive]",
  refl: () => "się",
  recip: () => "się [each other]",
  or: () => "„…” [direct speech]",
  nonch: () => "coś/nic",
  E: () => "[no subject]",
  distrp: () => "po … [each]",
  qub: () => "[particle]",
};

function describeKind<K extends Kind>(kind: K, phrase: PhraseOf<K>): string {
  return DESCRIPTION[kind](phrase);
}

export function describePhrase(phrase: Phrase): string {
  return describeKind(phrase.kind, phrase);
}

function isPlainSubject(position: Position): boolean {
  return position.labels.includes("subj") && position.phrases.every((p) => p.kind === "np" && p.case === "str");
}

type PronounClause = PhraseOf<"ncp" | "prepncp">;

function isClause(phrase: Phrase): phrase is PhraseOf<"cp"> {
  return phrase.kind === "cp";
}

function isPronounClause(phrase: Phrase): phrase is PronounClause {
  return phrase.kind === "ncp" || phrase.kind === "prepncp";
}

/** The pronoun a clause follows: "to", "na to". */
function pronounHead(phrase: PronounClause): string {
  const it = CASES[phrase.case].it;
  return phrase.kind === "ncp" ? it : `${phrase.prep} ${it}`;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Each pronoun's clause words, in the order the pronouns first come. */
function groupByHead(phrases: readonly PronounClause[]): ReadonlyMap<string, readonly string[]> {
  return phrases.reduce((groups, phrase) => {
    const head = pronounHead(phrase);
    return groups.set(head, [...(groups.get(head) ?? []), clauseWord(phrase.complementizer, phrase.words)]);
  }, new Map<string, readonly string[]>());
}

/** A slot's alternatives, with clauses grouped: "na kogoś/coś [acc.] / że/żeby … / na to,
 * że/żeby …" rather than one entry per complementizer. */
function describeAlternatives(phrases: readonly Phrase[]): string {
  const others = phrases.filter((p) => !isClause(p) && !isPronounClause(p)).map(describePhrase);
  const clauseWords = phrases.filter(isClause).map((p) => clauseWord(p.complementizer, p.words));
  const clauses = clauseWords.length > 0 ? [`${unique(clauseWords).join("/")} …`] : [];
  const pronounClauses = [...groupByHead(phrases.filter(isPronounClause))].map(([head, words]) => `${head}, ${unique(words).join("/")} …`);
  return [...others, ...clauses, ...pronounClauses].join(" / ");
}

function describePosition(position: Position): string {
  if (position.labels.includes("subj") && position.phrases.every((p) => p.kind === "E")) {
    return "(impersonal)";
  }
  const options = describeAlternatives(position.phrases);
  return position.labels.includes("subj") ? `(subject: ${options})` : options;
}

// --- Which frame the sentence uses --------------------------------------------------

/** A complement of the word in the sentence: its preposition (if any) and case. */
export type Argument = {
  readonly prep: string | null;
  readonly case: Case;
  /** The complement's lemma, to match an idiom's fixed words (mieć na oku: oko). */
  readonly lemma: string | null;
};

const caseFits = (phrase: { readonly case: CaseSpec }, argument: Argument) => CASES[phrase.case].fits.includes(argument.case);
const nominalFits = (phrase: { readonly case: CaseSpec }, argument: Argument) => argument.prep === null && caseFits(phrase, argument);
const prepositionalFits = (phrase: { readonly prep: string; readonly case: CaseSpec }, argument: Argument) =>
  argument.prep === phrase.prep && caseFits(phrase, argument);

/** The phrases a complement can fill; the rest it can't. */
const FITS: Readonly<Partial<{ readonly [K in Kind]: (phrase: PhraseOf<K>, argument: Argument) => boolean }>> = {
  np: nominalFits,
  nump: nominalFits,
  prepnp: prepositionalFits,
  prepnump: prepositionalFits,
  xp: (phrase, argument) => phrase.realisations.some((r) => phraseFits(r, argument)),
  // a fixed word: the complement must be that word, in that phrase type
  lex: (phrase, argument) =>
    argument.lemma !== null && lemmaList(phrase.lemmas).includes(argument.lemma) && phraseFits(phrase.phrase, argument),
};

function kindFits<K extends Kind>(kind: K, phrase: PhraseOf<K>, argument: Argument): boolean {
  return FITS[kind]?.(phrase, argument) ?? false;
}

function phraseFits(phrase: Phrase, argument: Argument): boolean {
  return kindFits(phrase.kind, phrase, argument);
}

function isFixedPhrase(phrase: Phrase): boolean {
  return phrase.kind === "lex" || phrase.kind === "lexcompar" || phrase.kind === "fixed";
}

/** A slot only an idiom's fixed words fill: the sentence must contain them. */
function isFixed(position: Position): boolean {
  return position.phrases.every(isFixedPhrase);
}

const COMPLEMENT_RELATIONS: ReadonlySet<Deprel> = new Set<Deprel>(["obj", "iobj", "obl:arg", "obl"]);
const PREPOSITION_RELATION: Deprel = "case";

/** The complements of tokens[index] in the sentence: objects and obliques with a case,
 * each with the preposition attached to it (czeka na autobus -> na + Acc). */
export function argumentsOf(tokens: Token[], index: number): Argument[] {
  return tokens.flatMap((token, i) => {
    const caseValue = token.feats.Case;
    if (token.head !== index || !token.deprel || !COMPLEMENT_RELATIONS.has(token.deprel) || !caseValue) return [];
    const preposition = tokens.find((t) => t.head === i && t.deprel === PREPOSITION_RELATION && t.upos === "ADP");
    return [{ prep: preposition?.lemma?.toLowerCase() ?? null, case: caseValue, lemma: token.lemma }];
  });
}

/** Every argument fills a different non-subject slot of the schema, and every slot of
 * fixed words is filled (an idiom fits only if its words are in the sentence). */
function schemaFits(schema: Schema, args: readonly Argument[]): boolean {
  const slots = schema.positions.filter((p) => !p.labels.includes("subj"));
  const used = new Set<number>();
  const placed = args.every((argument) => {
    const slot = slots.findIndex((position, i) => !used.has(i) && position.phrases.some((p) => phraseFits(p, argument)));
    if (slot === -1) return false;
    used.add(slot);
    return true;
  });
  return placed && slots.every((position, i) => used.has(i) || !isFixed(position));
}

export function describe(schema: Schema): Frame {
  return {
    pattern: schema.positions
      .filter((p) => !isPlainSubject(p))
      .map(describePosition)
      .join(" + "),
    tags: [CERTAINTY_TAG[schema.certainty], NEGATION_TAG[schema.negation]].filter((tag) => tag !== null),
    idiom: schema.positions.some((p) => p.phrases.some(isFixedPhrase)),
    reflexive: schema.reflexive,
    here: false,
  };
}

/** The same pattern from another schema: it fits if either does, and keeps the fewer
 * reservations. */
function merge(existing: Frame, frame: Frame): Frame {
  return {
    ...existing,
    here: existing.here || frame.here,
    tags: frame.tags.length < existing.tags.length ? frame.tags : existing.tags,
  };
}

/** One line per distinct pattern: the ones the sentence fits first, then ordinary uses
 * before idioms, sure ones before ones with reservations. args: the word's complements
 * in the sentence (empty to mark none). */
export function frames(schemata: Schema[], args: Argument[] = []): Frame[] {
  // Of the schemata the sentence fits, mark only the tightest: fewest slots it leaves
  // empty (czeka na autobus fits "na + acc." and "na + acc. + how long"; the first)
  const unfilled = (schema: Schema) => schema.positions.filter((p) => !p.labels.includes("subj")).length - args.length;
  const fitting = args.length > 0 ? schemata.filter((s) => schemaFits(s, args)) : [];
  const tightest = Math.min(...fitting.map(unfilled));
  const byPattern = schemata
    .map((schema) => ({ ...describe(schema), here: fitting.includes(schema) && unfilled(schema) === tightest }))
    .reduce((patterns, frame) => {
      const key = `${frame.reflexive ? "się " : ""}${frame.pattern}`;
      const existing = patterns.get(key);
      return patterns.set(key, existing ? merge(existing, frame) : frame);
    }, new Map<string, Frame>());
  const rank = (f: Frame) => (f.here ? 0 : 4) + (f.idiom ? 2 : 0) + (f.tags.length > 0 ? 1 : 0);
  return [...byPattern.values()].sort((a, b) => rank(a) - rank(b));
}
