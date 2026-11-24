import assert from "node:assert/strict";
import { test } from "node:test";
import type { Token, CaseSpec, Lex, Phrase, Position, Schema } from "@skolia/shared/schema";
import { argumentsOf, describe as renderFrame, describePhrase as renderPhrase, frames as renderFrames } from "./valency.ts";

const describe = (schema: Schema) => flatten(renderFrame(schema));
const describePhrase = (phrase: Parameters<typeof renderPhrase>[0]) =>
  renderPhrase(phrase)
    .map((p) => p.text)
    .join("");
const frames = (...args: Parameters<typeof renderFrames>) => renderFrames(...args).map(flatten);
function flatten(frame: ReturnType<typeof renderFrame>) {
  return { ...frame, pattern: frame.pattern.map((p) => p.text).join("") };
}

test("brackets in a fixed phrase are not grammar labels", () => {
  assert.deepEqual(renderPhrase({ kind: "fixed", text: "w [nawiasie]", phrase: { kind: "np", case: "loc" } }), [
    { text: "„w [nawiasie]”", label: false },
  ]);
  assert.deepEqual(renderPhrase({ kind: "np", case: "gen" }), [
    { text: "kogoś/czegoś ", label: false },
    { text: "[gen.]", label: true },
  ]);
});

const SPECS: readonly CaseSpec[] = ["nom", "gen", "dat", "acc", "inst", "loc", "str", "part", "agr", "pred", "postp"];

function lex(phrase: Phrase, lemmas: Lex["lemmas"] = { kind: "xor", lemmas: ["oko", "ucho"] }): Lex {
  return { kind: "lex", phrase, form: { shape: "nominal", number: "sg" }, lemmas, modification: { kind: "natr", positions: [] } };
}

function schema(positions: Position[], extra: Partial<Schema> = {}): Schema {
  return {
    pos: "verb",
    lemma: "czekać",
    reflexive: false,
    certainty: "certain",
    negation: "any",
    predicative: false,
    aspect: "imperf",
    positions,
    ...extra,
  };
}

const SUBJECT: Position = { labels: ["subj"], phrases: [{ kind: "np", case: "str" }] };

test("noun phrases in every case spec", () => {
  assert.deepEqual(
    SPECS.map((spec) => describePhrase({ kind: "np", case: spec })),
    [
      "ktoś/coś [nom.]",
      "kogoś/czegoś [gen.]",
      "komuś/czemuś [dat.]",
      "kogoś/coś [acc.]",
      "kimś/czymś [ins.]",
      "kimś/czymś [loc.]",
      "kogoś/coś [acc.; gen. with nie]",
      "czegoś/coś [gen. some / acc. all]",
      "[same case]",
      "kimś/czymś [nom./ins.]",
      "[po-form]",
    ],
  );
  assert.equal(describePhrase({ kind: "nump", case: "dat" }), "komuś/czemuś [dat.]");
});

test("adjective and participle phrases in every case spec", () => {
  assert.deepEqual(
    SPECS.map((spec) => describePhrase({ kind: "adjp", case: spec })),
    [
      "jakiś [adjective, nom.]",
      "jakiś [adjective, gen.]",
      "jakiś [adjective, dat.]",
      "jakiś [adjective, acc.]",
      "jakiś [adjective, ins.]",
      "jakiś [adjective, loc.]",
      "jakiś [adjective, acc.]",
      "jakiś [adjective, gen./acc.]",
      "jakiś [adjective]",
      "jakiś [adjective, nom./ins.]",
      "jakiś [adjective, po-form]",
    ],
  );
  assert.equal(describePhrase({ kind: "ppasp", case: "inst" }), "jakiś [adjective, ins.]");
  assert.equal(describePhrase({ kind: "pactp", case: "agr" }), "jakiś [adjective]");
});

test("prepositional phrases in every case spec", () => {
  assert.deepEqual(
    SPECS.map((spec) => describePhrase({ kind: "prepnp", prep: "na", case: spec })),
    [
      "na ktoś/coś [nom.]",
      "na kogoś/czegoś [gen.]",
      "na komuś/czemuś [dat.]",
      "na kogoś/coś [acc.]",
      "na kimś/czymś [ins.]",
      "na kimś/czymś [loc.]",
      "na kogoś/coś [acc.]",
      "na … [gen./acc.]",
      "na … [same case]",
      "na … [nom./ins.]",
      "na … [po-form]",
    ],
  );
  assert.deepEqual(
    (["prepnump", "prepgerp", "prepppasp"] as const).map((kind) => describePhrase({ kind, prep: "z", case: "inst" })),
    ["z kimś/czymś [ins.]", "z kimś/czymś [ins.]", "z kimś/czymś [ins.]"],
  );
  assert.deepEqual(
    SPECS.map((spec) => describePhrase({ kind: "prepadjp", prep: "po", case: spec })),
    [
      "po jakiś [nom.]",
      "po jakiegoś [gen.]",
      "po jakiemuś [dat.]",
      "po jakiegoś [acc.]",
      "po jakimś [ins.]",
      "po jakimś [loc.]",
      "po jakiegoś [acc.]",
      "po jakiś [gen./acc.]",
      "po jakiś [same case]",
      "po jakiś [nom./ins.]",
      "po jakiemuś [adverb: po polsku]",
    ],
  );
  assert.equal(describePhrase({ kind: "comprepnp", prep: "w sprawie" }), "w sprawie …");
});

test("clauses with each kind of complementizer", () => {
  assert.deepEqual(
    (["że", "żeby2", "int", "rel", "jak"] as const).map((complementizer) => describePhrase({ kind: "cp", complementizer, words: [] })),
    ["że …", "żeby …", "czy/co/kto … [question]", "który/gdzie … [relative]", "jak …"],
  );
  assert.equal(describePhrase({ kind: "cp", complementizer: "int", words: ["kto", "co"] }), "kto/co …");
  assert.deepEqual(
    SPECS.map((spec) => describePhrase({ kind: "ncp", case: spec, complementizer: "że", words: [] })),
    [
      "to, że … [nom.]",
      "tego, że … [gen.]",
      "temu, że … [dat.]",
      "to, że … [acc.]",
      "tym, że … [ins.]",
      "tym, że … [loc.]",
      "to, że … [acc.]",
      "to, że … [gen./acc.]",
      "to, że … [same case]",
      "to, że … [nom./ins.]",
      "to, że … [po-form]",
    ],
  );
  assert.deepEqual(
    (["nom", "gen", "dat", "inst", "str", "postp"] as const).map((spec) =>
      describePhrase({ kind: "prepncp", prep: "o", case: spec, complementizer: "rel", words: [] }),
    ),
    [
      "o to, który/gdzie … [relative]",
      "o tego, który/gdzie … [relative]",
      "o temu, który/gdzie … [relative]",
      "o tym, który/gdzie … [relative]",
      "o to, który/gdzie … [relative]",
      "o to, który/gdzie … [relative]",
    ],
  );
});

test("the remaining phrase kinds", () => {
  const phrases: Phrase[] = [
    { kind: "infp", aspect: "perf" },
    { kind: "xp", category: "dur", realisations: [] },
    { kind: "advp", category: "caus" },
    { kind: "compar", comparator: "niż" },
    { kind: "fixed", phrase: { kind: "np", case: "acc" }, text: "w ogóle" },
    { kind: "possp" },
    { kind: "refl" },
    { kind: "recip" },
    { kind: "or" },
    { kind: "nonch" },
    { kind: "E" },
    { kind: "distrp" },
    { kind: "qub" },
  ];
  assert.deepEqual(phrases.map(describePhrase), [
    "robić coś [infinitive]",
    "jakiś czas [how long]",
    "z jakiegoś powodu [why]",
    "niż …",
    "„w ogóle”",
    "czyjś [possessive]",
    "się",
    "się [each other]",
    "„…” [direct speech]",
    "coś/nic",
    "[no subject]",
    "po … [each]",
    "[particle]",
  ]);
});

test("an idiom's fixed words with their phrase's preposition and case", () => {
  assert.deepEqual(
    SPECS.map((spec) => describePhrase(lex({ kind: "np", case: spec }))),
    [
      "oko/ucho [nom.]",
      "oko/ucho [gen.]",
      "oko/ucho [dat.]",
      "oko/ucho [acc.]",
      "oko/ucho [ins.]",
      "oko/ucho [loc.]",
      "oko/ucho [acc.]",
      "oko/ucho [gen./acc.]",
      "oko/ucho [same case]",
      "oko/ucho [nom./ins.]",
      "oko/ucho [po-form]",
    ],
  );
  assert.equal(describePhrase(lex({ kind: "prepadjp", prep: "na", case: "loc" })), "na oko/ucho [loc.]");
  assert.equal(describePhrase(lex({ kind: "adjp", case: "gen" }, { kind: "or", lemmas: ["dobry", "zły"] })), "dobry, zły [gen.]");
  assert.equal(describePhrase(lex({ kind: "advp", category: "mod" }, { kind: "one", lemma: "dobrze" })), "dobrze");
  assert.equal(
    describePhrase(lex({ kind: "xp", category: "locat", realisations: [{ kind: "prepnp", prep: "w", case: "loc" }] })),
    "w oko/ucho [loc.]",
  );
  assert.equal(describePhrase(lex({ kind: "xp", category: "locat", realisations: [] })), "oko/ucho");
  assert.equal(
    describePhrase({
      kind: "lexcompar",
      phrase: { kind: "compar", comparator: "jak" },
      parts: [
        lex({ kind: "np", case: "nom" }, { kind: "one", lemma: "dzień" }),
        lex({ kind: "np", case: "nom" }, { kind: "one", lemma: "noc" }),
      ],
    }),
    "dzień [nom.] noc [nom.]",
  );
});

test("a frame's tags, idiom flag and subject", () => {
  const object: Position = { labels: ["obj"], phrases: [{ kind: "np", case: "acc" }] };
  assert.deepEqual(describe(schema([SUBJECT, object], { certainty: "archaic", negation: "aff", reflexive: true })), {
    pattern: "kogoś/coś [acc.]",
    tags: ["archaic", "without nie"],
    idiom: false,
    reflexive: true,
    here: false,
  });
  const clauseSubject: Position = {
    labels: ["subj"],
    phrases: [
      { kind: "np", case: "str" },
      { kind: "cp", complementizer: "że", words: [] },
    ],
  };
  assert.deepEqual(
    describe(schema([clauseSubject, { labels: [], phrases: [{ kind: "fixed", phrase: { kind: "np", case: "acc" }, text: "w ogóle" }] }])),
    {
      pattern: "(subject: kogoś/coś [acc.; gen. with nie] / że …) + „w ogóle”",
      tags: [],
      idiom: true,
      reflexive: false,
      here: false,
    },
  );
});

test("a slot's clauses are grouped by the pronoun they follow", () => {
  const slot: Position = {
    labels: [],
    phrases: [
      { kind: "cp", complementizer: "int", words: [] },
      { kind: "ncp", case: "gen", complementizer: "rel", words: [] },
      { kind: "np", case: "inst" },
      { kind: "cp", complementizer: "żeby2", words: [] },
      { kind: "ncp", case: "gen", complementizer: "int", words: ["gdzie", "kiedy"] },
      { kind: "cp", complementizer: "int", words: [] },
      { kind: "ncp", case: "inst", complementizer: "jak", words: [] },
      { kind: "prepncp", prep: "o", case: "acc", complementizer: "że", words: [] },
      { kind: "ncp", case: "gen", complementizer: "rel", words: [] },
    ],
  };
  assert.equal(
    describe(schema([SUBJECT, slot])).pattern,
    "kimś/czymś [ins.] / czy/żeby … / tego, który/gdzie/kiedy … / tym, jak … / o to, że …",
  );
  assert.equal(describe(schema([{ labels: ["subj"], phrases: [{ kind: "E" }] }])).pattern, "(impersonal)");
});

test("which frames the sentence's complements fit", () => {
  const strObject: Position = { labels: ["obj"], phrases: [{ kind: "np", case: "str" }] };
  const partObject: Position = { labels: [], phrases: [{ kind: "np", case: "part" }] };
  const agrObject: Position = { labels: [], phrases: [{ kind: "np", case: "agr" }] };
  const where: Position = {
    labels: [],
    phrases: [{ kind: "xp", category: "locat", realisations: [{ kind: "prepnump", prep: "w", case: "loc" }] }],
  };
  const dative: Position = { labels: [], phrases: [{ kind: "np", case: "dat" }] };
  const here = (schemata: Schema[], args: Parameters<typeof frames>[1]) => frames(schemata, args).map((f) => [f.pattern, f.here]);
  assert.deepEqual(here([schema([SUBJECT, strObject])], [{ prep: null, case: "Gen", lemma: null }]), [
    ["kogoś/coś [acc.; gen. with nie]", true],
  ]);
  assert.deepEqual(here([schema([SUBJECT, partObject])], [{ prep: null, case: "Acc", lemma: null }]), [
    ["czegoś/coś [gen. some / acc. all]", true],
  ]);
  assert.deepEqual(here([schema([SUBJECT, agrObject])], [{ prep: null, case: "Nom", lemma: null }]), [["[same case]", false]]);
  assert.deepEqual(here([schema([SUBJECT, dative])], [{ prep: null, case: "Voc", lemma: null }]), [["komuś/czemuś [dat.]", false]]);
  assert.deepEqual(here([schema([SUBJECT, dative, where]), schema([SUBJECT, where])], [{ prep: "w", case: "Loc", lemma: "dom" }]), [
    ["gdzieś [where]", true],
    ["komuś/czemuś [dat.] + gdzieś [where]", false],
  ]);
  assert.deepEqual(
    here(
      [schema([SUBJECT, dative])],
      [
        { prep: null, case: "Dat", lemma: null },
        { prep: null, case: "Dat", lemma: null },
      ],
    ),
    [["komuś/czemuś [dat.]", false]],
  );
});

test("merged frames keep the fewest tags and rank by fit, idiom and tags", () => {
  const object: Position = { labels: [], phrases: [{ kind: "np", case: "gen" }] };
  const shown = frames([
    schema([SUBJECT, object], { certainty: "vulgar", negation: "neg" }),
    schema([SUBJECT, object], { certainty: "wrong" }),
    schema([SUBJECT, object], { reflexive: true, certainty: "doubtful" }),
    schema([SUBJECT, { labels: [], phrases: [lex({ kind: "np", case: "gen" })] }], { certainty: "colloquial" }),
    schema([SUBJECT, { labels: [], phrases: [{ kind: "np", case: "dat" }] }]),
  ]);
  assert.deepEqual(
    shown.map((f) => [f.reflexive, f.pattern, f.tags, f.idiom]),
    [
      [false, "komuś/czemuś [dat.]", [], false],
      [false, "kogoś/czegoś [gen.]", ["wrong"], false],
      [true, "kogoś/czegoś [gen.]", ["doubtful"], false],
      [false, "oko/ucho [gen.]", ["colloquial"], true],
    ],
  );
});

function token(start: number, end: number, text: string, extra: Partial<Token> = {}): Token {
  return {
    start,
    end,
    text,
    lemma: text,
    lemma_id: `pl:${text}:NOUN`,
    upos: "NOUN",
    xpos: null,
    feats: {},
    head: null,
    deprel: "root",
    ...extra,
  };
}

function readerSchema(positions: Schema["positions"], extra: Partial<Schema> = {}): Schema {
  return {
    pos: "verb",
    lemma: "szukać",
    reflexive: false,
    certainty: "certain",
    negation: "any",
    predicative: false,
    aspect: "imperf",
    positions,
    ...extra,
  };
}

const READER_SUBJECT = { labels: ["subj" as const], phrases: [{ kind: "np" as const, case: "str" as const }] };

test("frame phrases read like dictionary patterns", () => {
  assert.equal(describePhrase({ kind: "np", case: "gen" }), "kogoś/czegoś [gen.]");
  assert.equal(describePhrase({ kind: "np", case: "str" }), "kogoś/coś [acc.; gen. with nie]");
  assert.equal(describePhrase({ kind: "prepnp", prep: "na", case: "acc" }), "na kogoś/coś [acc.]");
  assert.equal(describePhrase({ kind: "prepadjp", prep: "ku", case: "dat" }), "ku jakiemuś [dat.]");
  assert.equal(describePhrase({ kind: "cp", complementizer: "że", words: [] }), "że …");
  assert.equal(describePhrase({ kind: "ncp", case: "gen", complementizer: "że", words: [] }), "tego, że … [gen.]");
});

test("frames drop the plain subject, merge duplicates, and put idioms last", () => {
  const object = { labels: [], phrases: [{ kind: "np" as const, case: "gen" as const }] };
  const idiom = {
    labels: [],
    phrases: [
      {
        kind: "lex" as const,
        phrase: { kind: "np" as const, case: "gen" as const },
        form: { shape: "nominal" as const, number: "sg" as const },
        lemmas: { kind: "one" as const, lemma: "guz" },
        modification: { kind: "natr" as const, positions: [] },
      },
    ],
  };
  const shown = frames([
    readerSchema([READER_SUBJECT, idiom]),
    readerSchema([READER_SUBJECT, object], { certainty: "colloquial" }),
    readerSchema([READER_SUBJECT, object]),
    readerSchema([{ labels: ["subj"], phrases: [{ kind: "E" }] }, object], { negation: "neg" }),
  ]);
  assert.deepEqual(
    shown.map((f) => [f.pattern, f.tags, f.idiom]),
    [
      ["kogoś/czegoś [gen.]", [], false],
      ["(impersonal) + kogoś/czegoś [gen.]", ["with nie"], false],
      ["guz [gen.]", [], true],
    ],
  );
});

test("an idiom fits only when its fixed word is in the sentence", () => {
  // mieć na oku: na + loc. with the fixed word oko
  const naOku: Schema["positions"][number] = {
    labels: [],
    phrases: [
      {
        kind: "lex",
        phrase: { kind: "prepnp", prep: "na", case: "loc" },
        form: { shape: "nominal", number: "sg" },
        lemmas: { kind: "one", lemma: "oko" },
        modification: { kind: "natr", positions: [] },
      },
    ],
  };
  const idiom = readerSchema([READER_SUBJECT, naOku], { lemma: "mieć" });
  const withOko = frames([idiom], [{ prep: "na", case: "Loc", lemma: "oko" }]);
  const withStole = frames([idiom], [{ prep: "na", case: "Loc", lemma: "stół" }]);
  assert.equal(withOko[0]?.here, true);
  assert.equal(withStole[0]?.here, false);
});

test("the frame the sentence uses comes first, and clause alternatives are grouped", () => {
  // Wiele osób czeka na autobus: czeka's complement is na + accusative
  const sentence: Token[] = [
    token(0, 5, "czeka", { lemma: "czekać", upos: "VERB" }),
    token(6, 8, "na", { lemma: "na", upos: "ADP", head: 2, deprel: "case" }),
    token(9, 16, "autobus", { lemma: "autobus", head: 0, deprel: "obl:arg", feats: { Case: "Acc" } }),
  ];
  const args = argumentsOf(sentence, 0);
  assert.deepEqual(args, [{ prep: "na", case: "Acc", lemma: "autobus" }]);
  const genitive = { labels: [], phrases: [{ kind: "np" as const, case: "gen" as const }] };
  const naOrClause: Schema["positions"][number] = {
    labels: [],
    phrases: [
      { kind: "prepnp", prep: "na", case: "acc" },
      { kind: "cp", complementizer: "że", words: [] },
      { kind: "cp", complementizer: "żeby", words: [] },
      { kind: "prepncp", prep: "na", case: "acc", complementizer: "że", words: [] },
      { kind: "prepncp", prep: "na", case: "acc", complementizer: "żeby", words: [] },
    ],
  };
  const shown = frames([readerSchema([READER_SUBJECT, genitive]), readerSchema([READER_SUBJECT, naOrClause])], args);
  assert.deepEqual(
    shown.map((f) => [f.pattern, f.here]),
    [
      ["na kogoś/coś [acc.] / że/żeby … / na to, że/żeby …", true],
      ["kogoś/czegoś [gen.]", false],
    ],
  );
});
