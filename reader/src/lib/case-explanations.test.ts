import assert from "node:assert/strict";
import { test } from "node:test";
import type { Feats, Token } from "@skolia/shared/schema";
import { caseReasonFor, explainCase, formatCaseReason } from "./case-explanations.ts";

const GEN_SG: Feats = { Case: "Gen", Number: "Sing", Gender: "Masc", Animacy: "Nhum" };

function explanationOf(tokens: Token[], index: number) {
  const reason = caseReasonFor(tokens, index);
  return reason && explainCase(reason, tokens[index]?.case_reason?.trigger ?? null);
}

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

test("case explanations: governor, two-case prepositions, agreement chains", () => {
  // Szukam starego psa w domu
  const tokens: Token[] = [
    token(0, 6, "Szukam", { lemma: "szukać", upos: "VERB" }),
    token(7, 14, "starego", { upos: "ADJ", head: 2, deprel: "amod", feats: GEN_SG, case_reason: { rule: "agreement", trigger: 2 } }),
    token(15, 18, "psa", { head: 0, deprel: "obj", feats: GEN_SG, case_reason: { rule: "verb", trigger: 0, governor: "szukać" } }),
    token(19, 20, "w", { upos: "ADP", head: 4, deprel: "case" }),
    token(21, 25, "domu", {
      head: 0,
      deprel: "obl",
      feats: { Case: "Loc" },
      case_reason: { rule: "preposition", trigger: 3, governor: "w" },
    }),
  ];
  const reason = caseReasonFor(tokens, 1);
  assert.deepEqual(reason, {
    case: "Gen",
    rule: "agreement",
    word: "psa",
    governor: "psa",
    related: { case: "Gen", rule: "verb", word: "Szukam", governor: "szukać" },
  });
  assert.equal(formatCaseReason(reason!), "It agrees with psa. psa: szukać governs the genitive for its object.");
  assert.deepEqual(explanationOf(tokens, 2), {
    text: "szukać governs the genitive for its object.",
    trigger: 0,
    parts: [
      { text: "szukać", trigger: true },
      { text: " governs the genitive for its object.", trigger: false },
    ],
  });
  assert.equal(explanationOf(tokens, 1)?.text, "It agrees with psa. psa: szukać governs the genitive for its object.");
  assert.deepEqual(
    explanationOf(tokens, 1)
      ?.parts.filter((p) => p.trigger)
      .map((p) => p.text),
    ["psa"],
  );
  assert.deepEqual(explanationOf(tokens, 4)?.parts[0], { text: "w", trigger: true });
  assert.equal(explanationOf(tokens, 4)?.text, "w + locative means where (w domu).");
  assert.equal(explanationOf(tokens, 0), null);
});

test("a possessive genitive names the possessed noun, not the owner", () => {
  const tokens = [
    token(0, 7, "lodówka"),
    token(8, 13, "moich"),
    token(14, 22, "rodziców", {
      head: 0,
      deprel: "nmod",
      feats: { Case: "Gen", Number: "Plur" },
      case_reason: { rule: "possessive", trigger: 0 },
    }),
  ];
  assert.deepEqual(explanationOf(tokens, 2), {
    text: `The genitive tells you whose lodówka it is (dom brata = "the brother's house").`,
    trigger: 0,
    parts: [
      { text: "The genitive tells you whose ", trigger: false },
      { text: "lodówka", trigger: true },
      { text: ` it is (dom brata = "the brother's house").`, trigger: false },
    ],
  });
});
