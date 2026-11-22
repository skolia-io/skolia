"""English lexicon: Kaikki's English entries, with their forms as paradigms.

English Wiktionary lists each word's inflections (plural, third-person singular, past,
participles, comparative), and its irregular verbs in full (am, are, is, was, were), so
the paradigms come from there and are stored in the lexicon. Their features follow UD
English EWT, which the parser is trained on: finite verbs carry Person and Number, so a
form gets one feature set per person and number it serves.
"""

from collections.abc import Iterable, Iterator, Mapping

from skolia.ud import Feats, Mood, Number, Person, Tense, Upos

from .. import kaikki
from .. import senses as kaikki_senses
from ..inflections import Inflection, form, inflections, noun_forms, paradigm, unique
from ..kaikki import KaikkiEntry, KaikkiForm, KaikkiSound
from ..pronunciation import pronunciations, recordings
from ..schema import Accent, Form, Paradigm
from ..source import Converted, Pronounced

ATTRIBUTION = (
    "Meanings, forms and pronunciations from Wiktionary (https://en.wiktionary.org) via "
    "kaikki.org, CC BY-SA 4.0"
)

# Wiktionary's accent tags -> the accents the reader shows. British is Standard Southern
# British, the newer name for Received Pronunciation.
ACCENTS: tuple[Accent, ...] = ("UK", "US")
ACCENT_TAGS: Mapping[str, Accent] = {
    "Received-Pronunciation": "UK",
    "UK": "UK",
    "British": "UK",
    "General-American": "US",
    "US": "US",
}
# Some say the accent in a note instead: lead (the metal) has "Received Pronunciation,
# General American, CA]"
ACCENT_NOTES: Mapping[str, Accent] = {
    "Received Pronunciation": "UK",
    "General American": "US",
}
# Notes kept on a sound with no accent: a function word said stressed or not (of: /ɒv/,
# /əv/). Any other note is a region or a merger, like the tags left out.
FORM_NOTES = {"strong form", "weak form", "stressed form", "unstressed form"}
# Not how the word is said today, even when also tagged UK or US
NOT_TODAY_TAGS = {"obsolete", "archaic", "dialectal", "Early", "Middle"}

# Parts of speech are kaikki.POS. Where the analyser differs (can, will as AUX), a bundle
# falls back to the same lemma under another UPOS. Left out: affixes, letters, symbols,
# contractions (the parser splits don't into do + n't); phrases and proverbs become
# multi-word expressions later.

# Suffixes the parser splits off as words of their own: Wiktionary files the possessive
# (the dog's bone) under the suffix -'s, UD makes it a particle, lemma 's
ENCLITICS: dict[str, tuple[str, Upos]] = {"-'s": ("'s", "PART")}

INFLECTION_TAGS = kaikki.INFLECTION_TAGS | {
    "subjunctive",
    "infinitive",
    "gerund",
    "comparative",
    "superlative",
}

SKIPPED_FORM_TAGS = kaikki.SKIPPED_FORM_TAGS | {
    "pronunciation-spelling",
    # can's "participle" able: another word standing in for the missing form
    "suppletive",
}

# be's table lists thou art beside you are with the same tags and no archaic one. The few
# other untagged thou forms (sattest, victualleth) are on rare verbs and left alone.
UNTAGGED_ARCHAIC_FORMS = {"art", "'rt"}

PERSONS: tuple[Person, ...] = ("1", "2", "3")
NUMBERS: tuple[Number, ...] = ("Sing", "Plur")
TENSE_TAGS: Mapping[str, Tense] = {"present": "Pres", "past": "Past"}


class Source:
    attribution = ATTRIBUTION
    grammar_tags: frozenset[str] = frozenset()
    version = ""

    def convert(self, entry: KaikkiEntry) -> Converted | None:
        headword = _headword(entry)
        if headword is None:
            return None
        word, upos = headword
        found = (
            kaikki_senses.sense(kaikki_sense, INFLECTION_TAGS, [])
            for kaikki_sense in entry.get("senses", [])
        )
        senses = [s for s in found if s is not None]
        if not senses:
            return None
        relations = list(kaikki_senses.relations(entry, INFLECTION_TAGS, self.grammar_tags))
        paradigms = paradigm(paradigm_forms(word, upos, entry.get("forms", [])))
        return Converted(word, (upos,), senses, relations, paradigms)

    def pronounce(self, entry: KaikkiEntry) -> Pronounced | None:
        headword = _headword(entry)
        if headword is None:
            return None
        word, upos = headword
        sounds = entry.get("sounds", [])
        found, heard = pronunciations(sounds, _accents), recordings(sounds)
        return Pronounced(word, (upos,), found, heard) if found or heard else None

    def paradigms(self, lemma: str, upos: Upos) -> list[Paradigm]:
        return []

    def hand_entries(self) -> Iterable[Converted]:
        return ()


def _headword(entry: KaikkiEntry) -> tuple[str, Upos] | None:
    """The word and its part of speech, if it's one word of a part of speech kept."""
    word, pos = entry.get("word", ""), entry.get("pos", "")
    upos = kaikki.POS.get(pos)
    if pos == "suffix" and word in ENCLITICS:
        word, upos = ENCLITICS[word]
    if upos is None or not word or " " in word:
        return None
    return word, upos


def _accents(sound: KaikkiSound) -> list[Accent] | None:
    """UK, US, or both from the tags, else from the note; every accent when there are
    neither. None for other accents (Scotland, Australia) and older English."""
    tags, note = sound.get("tags", []), sound.get("note", "")
    if NOT_TODAY_TAGS.intersection(tags):
        return None
    accents: set[Accent]
    if tags:
        accents = {ACCENT_TAGS[t] for t in tags if t in ACCENT_TAGS}
    elif note and note not in FORM_NOTES:
        accents = {accent for text, accent in ACCENT_NOTES.items() if text in note}
    else:
        return []
    return [a for a in ACCENTS if a in accents] or None


def paradigm_forms(word: str, upos: Upos, kaikki_forms: Iterable[KaikkiForm]) -> Iterator[Form]:
    """The headword and its inflections, each with every feature set it has, once."""
    return unique(_paradigm_forms(word, upos, list(kaikki_forms)))


def _paradigm_forms(word: str, upos: Upos, kaikki_forms: list[KaikkiForm]) -> Iterator[Form]:
    found = inflections(kaikki_forms, SKIPPED_FORM_TAGS, UNTAGGED_ARCHAIC_FORMS)
    match upos:
        case "NOUN" | "PROPN":
            yield from noun_forms(word, found)
        case "ADJ" | "ADV":
            yield form(word, {"Degree": "Pos"})
            for text, tags in found:
                if tags == {"comparative"}:
                    yield form(text, {"Degree": "Cmp"})
                elif tags == {"superlative"}:
                    yield form(text, {"Degree": "Sup"})
        case "VERB":
            # A modal's table gives its infinitive as "-" (can, must: no to can)
            no_infinitive = any(
                f.get("form") == "-" and "infinitive" in f.get("tags", []) for f in kaikki_forms
            )
            yield from _verb_forms(word, found, no_infinitive=no_infinitive)
        case _:
            return


def _verb_forms(  # noqa: C901, PLR0912
    word: str, found: list[Inflection], *, no_infinitive: bool
) -> Iterator[Form]:
    """The base form is the infinitive, the imperative, and the present of every person
    and number no other form covers (all but the third-person singular, usually). A verb
    Wiktionary gives no inflections (could, would, ought) has no paradigm."""
    if not found:
        return
    present_taken: set[tuple[Person, Number]] = set()
    for text, tags in found:
        if "participle" in tags:
            tense = next((TENSE_TAGS[t] for t in tags if t in TENSE_TAGS), None)
            if tense == "Past":
                yield form(text, {"Tense": "Past", "VerbForm": "Part"})
                yield form(text, {"Tense": "Past", "VerbForm": "Part", "Voice": "Pass"})
            elif tense == "Pres":
                yield form(text, {"Tense": "Pres", "VerbForm": "Part"})
                yield form(text, {"VerbForm": "Ger"})
            continue
        if "imperative" in tags or "infinitive" in tags:
            # be's own tables list them; the base form below covers them
            continue
        finite: Tense | None = next((TENSE_TAGS[t] for t in tags if t in TENSE_TAGS), None)
        if finite is None:
            continue
        mood: Mood = "Sub" if "subjunctive" in tags else "Ind"
        for person, number in _persons(tags):
            if finite == "Pres" and mood == "Ind":
                present_taken.add((person, number))
            yield form(
                text,
                {
                    "Mood": mood,
                    "Number": number,
                    "Person": person,
                    "Tense": finite,
                    "VerbForm": "Fin",
                },
            )
    if not no_infinitive:
        yield form(word, {"VerbForm": "Inf"})
        yield form(word, {"Mood": "Imp", "VerbForm": "Fin"})
    for person in PERSONS:
        for number in NUMBERS:
            if (person, number) not in present_taken:
                feats: Feats = {
                    "Mood": "Ind",
                    "Number": number,
                    "Person": person,
                    "Tense": "Pres",
                    "VerbForm": "Fin",
                }
                yield form(word, feats)


def _persons(tags: set[str]) -> Iterator[tuple[Person, Number]]:
    """The persons and numbers a finite form's tags name; all of them when it names none
    (the past of a regular verb: walked)."""
    persons: list[Person] = [
        kaikki.PERSON_TAGS[t] for t in tags if t in kaikki.PERSON_TAGS
    ] or list(PERSONS)
    numbers: list[Number] = [
        kaikki.NUMBER_TAGS[t] for t in tags if t in kaikki.NUMBER_TAGS
    ] or list(NUMBERS)
    for person in persons:
        for number in numbers:
            yield person, number
