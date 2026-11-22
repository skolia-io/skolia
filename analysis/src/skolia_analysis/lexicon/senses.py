"""Kaikki senses into the lexicon's: the part every language's conversion shares.

Wiktionary's sense tags are English whatever the language (genitive, plural, diminutive),
so a language only says which of them mark an inflected form.
"""

from collections.abc import Collection, Iterator, Sequence

from ..schema import Feats
from .kaikki import KaikkiEntry, KaikkiSense
from .schema import Derivation, DerivedFrom, Example, Relation, Sense, VariantOf

MAX_EXAMPLES = 3

FORM_OF_TAG = "form-of"
ALT_OF_TAG = "alt-of"
MARKER_TAGS = frozenset({FORM_OF_TAG, ALT_OF_TAG})
"""Kaikki's tags for a sense that points at another word, not labels of its own."""

# Tags on a form-of sense that say how its word is derived from the target, the first
# that's there winning
DERIVATIONS: Sequence[tuple[str, Derivation]] = (
    ("diminutive", "diminutive"),
    ("augmentative", "augmentative"),
    ("endearing", "endearing"),
    ("noun-from-verb", "noun-from-verb"),
    ("agent", "agent-noun"),
    ("frequentative", "frequentative"),
    ("iterative", "iterative"),
)

# Glosses of a form-of sense that make its word the other gender's, when no tag says how
# it's derived: a feminine diminutive is a diminutive. Not the gender tags: Kaikki gives
# the word's own gender to every sense, so they'd make cholère, "obsolete form of
# colère", the feminine of colère.
EQUIVALENTS: Sequence[tuple[str, Derivation]] = (
    ("female equivalent of", "feminine"),
    ("male equivalent of", "masculine"),
)

# Kaikki sometimes tags an inflected form's sense only form-of, its gloss saying the rest:
# "inflection of ładny: genitive/locative plural"
INFLECTION_GLOSS = "inflection of"


def is_inflection(kaikki_sense: KaikkiSense, inflection_tags: Collection[str]) -> bool:
    """Whether the sense only points at the word's lemma ("genitive plural of kuna"),
    which the analyser already gives such a word."""
    if not (kaikki_sense.get("form_of") or kaikki_sense.get("alt_of")):
        return False
    glosses = kaikki_sense.get("glosses", [])
    return any(t in inflection_tags for t in kaikki_sense.get("tags", [])) or bool(
        glosses and glosses[0].lower().startswith(INFLECTION_GLOSS)
    )


def sense(
    kaikki_sense: KaikkiSense,
    inflection_tags: Collection[str],
    when: list[Feats],
    extra_tags: Sequence[str] = (),
) -> Sense | None:
    """None for a sense with no gloss, or an inflection's (is_inflection).
    when: the features that select the sense; empty for always."""
    glosses = kaikki_sense.get("glosses", [])
    if not glosses or is_inflection(kaikki_sense, inflection_tags):
        return None
    result: Sense = {
        "gloss": ": ".join(glosses),
        "tags": [t for t in kaikki_sense.get("tags", []) if t != FORM_OF_TAG] + list(extra_tags),
    }
    if when:
        result["when"] = when
    found = list(examples(kaikki_sense))
    if found:
        result["examples"] = found
    return result


def examples(kaikki_sense: KaikkiSense) -> Iterator[Example]:
    for example in kaikki_sense.get("examples", [])[:MAX_EXAMPLES]:
        text = example.get("text")
        if not text:
            continue
        result: Example = {"text": text}
        translation = example.get("translation") or example.get("english")
        if translation:
            result["translation"] = translation
        yield result


def relations(
    entry: KaikkiEntry, inflection_tags: Collection[str], grammar_tags: Collection[str]
) -> Iterator[Relation]:
    """The words a form-of or alt-of sense points at, other than an inflection's lemma:
    derived from ("diminutive of rubel", by DERIVATIONS and EQUIVALENTS) or otherwise a
    variant of ("emphatic form of niech", "British standard spelling of color"), each
    target once. grammar_tags are left off a variant's tags."""
    seen: set[str] = set()
    for kaikki_sense in entry.get("senses", []):
        if is_inflection(kaikki_sense, inflection_tags):
            continue
        tags = kaikki_sense.get("tags", [])
        how = derivation(kaikki_sense)
        for target in kaikki_sense.get("form_of", []) + kaikki_sense.get("alt_of", []):
            lemma = target.get("word")
            if not lemma or lemma in seen:
                continue
            seen.add(lemma)
            if how is not None:
                derived: DerivedFrom = {"kind": "derived-from", "lemma": lemma, "how": how}
                yield derived
            else:
                labels = [t for t in tags if t not in MARKER_TAGS and t not in grammar_tags]
                variant: VariantOf = {"kind": "variant-of", "lemma": lemma, "tags": labels}
                yield variant


def derivation(kaikki_sense: KaikkiSense) -> Derivation | None:
    """How a form-of sense's word is derived from its target, if it's a derivation."""
    tags = kaikki_sense.get("tags", [])
    glosses = kaikki_sense.get("glosses", [])
    gloss = glosses[0].lower() if glosses else ""
    tagged: Derivation | None = next((d for tag, d in DERIVATIONS if tag in tags), None)
    named: Derivation | None = next(
        (d for prefix, d in EQUIVALENTS if gloss.startswith(prefix)), None
    )
    return tagged or named
