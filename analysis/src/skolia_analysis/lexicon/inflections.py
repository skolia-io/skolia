"""What English and French do alike with a Wiktionary entry's forms: pick its one-word
inflections, list a noun's, and make a paradigm of them. Their tags are UD's, so a form
has no separate language-specific tag."""

from collections.abc import Collection, Iterable, Iterator

from ..schema import Feats
from .kaikki import KaikkiForm
from .schema import Form, Paradigm

type Inflection = tuple[str, set[str]]
"""A form and its Wiktionary tags."""


def form(text: str, feats: Feats) -> Form:
    return {"form": text, "xpos": "", "feats": feats}


def inflections(
    kaikki_forms: Iterable[KaikkiForm],
    skipped_tags: Collection[str],
    skipped_forms: Collection[str] = (),
) -> list[Inflection]:
    """The forms that are one token: "more beautiful" or "avoir + past participle" are
    several, and "-" stands for a form a word lacks."""
    return [
        (text, tags)
        for f in kaikki_forms
        if (text := f.get("form", ""))
        and " " not in text
        and text != "-"
        and text not in skipped_forms
        and not (tags := set(f.get("tags", []))).intersection(skipped_tags)
    ]


def noun_forms(word: str, found: Iterable[Inflection]) -> Iterator[Form]:
    yield form(word, {"Number": "Sing"})
    for text, tags in found:
        if tags == {"plural"}:
            yield form(text, {"Number": "Plur"})


def paradigm(forms: Iterable[Form]) -> list[Paradigm]:
    """One table of the forms, or none for a word with one form. Wiktionary splits a word
    by etymology, usually with the same forms (bank, the shore and the institution); the
    build's merge keeps one copy of each table."""
    found = list(forms)
    return [{"homonym": "", "forms": found}] if len(found) > 1 else []


def unique(forms: Iterable[Form]) -> Iterator[Form]:
    """Each form with each feature set once: Kaikki lists a verb's forms from the headword
    line (walked: past) and again from its conjugation table (walked: first-person singular
    past)."""
    seen: set[tuple[str, tuple[tuple[str, object], ...]]] = set()
    for found in forms:
        key = (found["form"], tuple(sorted(found["feats"].items())))
        if key not in seen:
            seen.add(key)
            yield found
