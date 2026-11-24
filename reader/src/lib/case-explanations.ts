// "Why this case?": the analysis's case_reason (lang/pl/cases.py) in plain English.
import type { Case, Token } from "@skolia/shared/schema";
import { CASE_NAME } from "@skolia/shared/ud";
import type { ClozeCaseReason } from "@skolia/shared/api";

type CaseFact = NonNullable<ClozeCaseReason["related"]>;

interface CaseExplanation {
  text: string;
  trigger: number | null;
  parts: { text: string; trigger: boolean }[];
}

// Prepositions that take two cases, with what each means
const TWO_CASE: Partial<Record<string, Partial<Record<Case, string>>>> = {
  w: { Loc: "where (w domu)", Acc: "where to, or into (w dom)" },
  na: { Loc: "where, on (na stole)", Acc: "where to, onto, or for (na stół, na tydzień)" },
  o: { Loc: "about (o psie)", Acc: "for, or against (prosić o pomoc, oprzeć o ścianę)" },
  po: { Loc: "after, or along (po obiedzie, po mieście)", Acc: "to fetch, or up to (po chleb, po kolana)" },
  za: { Ins: "behind, where (za domem)", Acc: "behind, where to; or for (za dom, dziękuję za pomoc)" },
  pod: { Ins: "under, where (pod stołem)", Acc: "under, where to (pod stół)" },
  nad: { Ins: "above, where (nad stołem)", Acc: "above, where to (nad morze)" },
  przed: { Ins: "in front of, or before (przed domem, przed obiadem)", Acc: "in front of, where to (przed dom)" },
  między: { Ins: "between, where (między domami)", Acc: "between, where to (między domy)" },
};

function caseFact(tokens: readonly Token[], index: number): CaseFact | null {
  const token = tokens[index];
  const reason = token?.case_reason;
  const caseValue = token?.feats.Case;
  if (!reason || !caseValue) return null;
  const other = reason.trigger == null ? undefined : tokens[reason.trigger];
  const governor = reason.governor ?? other?.lemma;
  return { case: caseValue, rule: reason.rule, ...(other?.text && { word: other.text }), ...(governor && { governor }) };
}

/** Snapshot the rule and, for agreement or coordination, one related rule. */
export function caseReasonFor(tokens: readonly Token[], index: number): ClozeCaseReason | null {
  const fact = caseFact(tokens, index);
  if (!fact) return null;
  const trigger = tokens[index]?.case_reason?.trigger;
  const related = trigger != null && (fact.rule === "agreement" || fact.rule === "coordination") ? caseFact(tokens, trigger) : null;
  return related ? { ...fact, related } : fact;
}

export function formatCaseReason(reason: ClozeCaseReason): string {
  const { case: caseValue, word = "", governor = word, related } = reason;
  const name = CASE_NAME[caseValue];
  const chained = () => (related ? ` ${word}: ${formatCaseReason(related)}` : "");
  switch (reason.rule) {
    case "vocative":
      return "Someone is being addressed.";
    case "preposition": {
      const meaning = TWO_CASE[governor]?.[caseValue];
      return meaning ? `${governor} + ${name} means ${meaning}.` : `${governor} takes the ${name}.`;
    }
    case "agreement":
      return `It agrees with ${word}.${chained()}`;
    case "coordination":
      return `It's listed with ${word}, so it takes the same case.${chained()}`;
    case "numeral":
      return `After ${word}, a noun goes in the genitive (numbers from five, and words like wiele, kilka, dużo).`;
    case "verb":
      return `${governor} governs the ${name} for its object.`;
    case "negation":
      return `${governor} takes the accusative (its object), but nie turns it into the genitive.`;
    case "structural":
      return `It's the object of ${governor}, and objects are accusative.`;
    case "partitive":
      return `${governor} takes the genitive for "some of" and the accusative for "all of".`;
    case "subject":
      return `It's the subject of ${word}, and subjects are nominative.`;
    case "predicate":
      return `After ${governor}, a noun that says what the subject is goes in the instrumental (jest lekarzem).`;
    case "description":
      return `With an adjective, a genitive says what something is like, after ${governor} or after a noun (jest średniego wzrostu, ściany jasnego koloru).`;
    case "possessive":
      return `The genitive tells you whose ${word} it is (dom brata = "the brother's house").`;
    case "noun-complement":
      return `It completes the noun ${word}, and a noun's complement is genitive.`;
    case "verbal-noun":
      return `${word} is a noun made from ${governor}, and its object is genitive (czytać książkę → czytanie książki).`;
    case "instrumental":
      return "Instrumental without a preposition: by means of, or when (pisać długopisem, wieczorem).";
    default: {
      const exhaustive: never = reason.rule;
      return exhaustive;
    }
  }
}

export function explainCase(reason: ClozeCaseReason, trigger: number | null): CaseExplanation {
  const text = formatCaseReason(reason);
  const named = trigger === null ? null : [reason.word, reason.governor].find((w) => w && wholeWord(w).test(text));
  return { text, trigger, parts: named ? splitFirst(text, named) : [{ text, trigger: false }] };
}

function wholeWord(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, "u");
}

function splitFirst(text: string, word: string): { text: string; trigger: boolean }[] {
  const match = wholeWord(word).exec(text);
  if (!match) return [{ text, trigger: false }];
  const end = match.index + word.length;
  return [
    { text: text.slice(0, match.index), trigger: false },
    { text: word, trigger: true },
    { text: text.slice(end), trigger: false },
  ].filter((part) => part.text !== "");
}
