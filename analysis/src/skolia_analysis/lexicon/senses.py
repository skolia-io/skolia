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

# Tags on a form-of sense that say how its word is derived from the target, the first
# that's there winning: a feminine diminutive is a diminutive
DERIVATIONS: Sequence[tuple[str, Derivation]] = (
    ("diminutive", "diminutive"),
    ("augmentative", "augmentative"),
    ("endearing", "endearing"),
    ("noun-from-verb", "noun-from-verb"),
    ("agent", "agent-noun"),
    ("frequentative", "frequentative"),
    ("iterative", "iterative"),
    ("feminine", "feminine"),
    ("masculine", "masculine"),
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
    """The words a form-of sense points at, other than an inflection's lemma: derived
    from ("diminutive of rubel", by DERIVATIONS) or otherwise a variant of ("emphatic form
    of niech"), each target once. grammar_tags are left off a variant's tags."""
    seen: set[str] = set()
    for kaikki_sense in entry.get("senses", []):
        if is_inflection(kaikki_sense, inflection_tags):
            continue
        tags = kaikki_sense.get("tags", [])
        how: Derivation | None = next((d for tag, d in DERIVATIONS if tag in tags), None)
        for target in kaikki_sense.get("form_of", []):
            lemma = target.get("word")
            if not lemma or lemma in seen:
                continue
            seen.add(lemma)
            if how is not None:
                derived: DerivedFrom = {"kind": "derived-from", "lemma": lemma, "how": how}
                yield derived
            else:
                labels = [t for t in tags if t != FORM_OF_TAG and t not in grammar_tags]
                variant: VariantOf = {"kind": "variant-of", "lemma": lemma, "tags": labels}
                yield variant
