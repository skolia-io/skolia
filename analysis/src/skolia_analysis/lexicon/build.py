"""Kaikki extract -> a language's lexicon (store.py), keyed by the analyser's lemma_id."""

import hashlib
import json
from collections.abc import Collection, Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import NamedTuple, assert_never, cast

from ..blob import lemma_id
from ..schema import Feats, Upos
from . import commons, kaikki, store
from .entry import FeatsTable, Frames, Row, make, no_frames
from .pronunciation import merge as merge_pronunciations
from .pronunciation import merge_recordings
from .schema import Example, Paradigm, Pronunciation, Recording, Relation, Sense
from .source import Converted, LexiconSource, Pronounced

LEXICON_VERSION = "10"
"""Goes up when what the build makes changes, so every environment loads it again."""


@dataclass
class Merged:
    lemma: str
    upos: Upos
    senses: list[Sense] = field(default_factory=lambda: list[Sense]())
    relations: list[Relation] = field(default_factory=lambda: list[Relation]())
    paradigms: list[Paradigm] = field(default_factory=lambda: list[Paradigm]())
    grammar: Feats = field(default_factory=lambda: Feats())


@dataclass
class Stats:
    entries: int = 0
    skipped: int = 0
    pronounced: int = 0
    """Words with a pronunciation, by part of speech."""
    recorded: int = 0
    """Words with a recording, by part of speech."""
    commons: int = 0
    """Spellings with a recording from Commons."""


def merge(
    converted: Iterable[Converted], grammar_tags: Collection[str] = ()
) -> dict[tuple[str, Upos], Merged]:
    """Wiktionary splits a word by etymology and gender (pies the dog, the cop, the peg);
    the analyser can only tell them apart by features, so they merge into one entry
    whose senses carry the features that select them. grammar_tags come off the senses:
    the entry's grammar says them."""
    merged: dict[tuple[str, Upos], Merged] = {}
    for entry in converted:
        for upos in entry.upos:
            target = merged.setdefault((entry.lemma, upos), Merged(entry.lemma, upos))
            target.senses += entry.senses
            target.relations += [r for r in entry.relations if r not in target.relations]
            target.paradigms += entry.paradigms
    for target in merged.values():
        target.grammar = _lift_shared_when(target.senses)
        for sense in target.senses:
            sense["tags"] = [t for t in sense["tags"] if t not in grammar_tags]
        target.paradigms = _drop_contained(target.paradigms)
    return merged


def _drop_contained(paradigms: list[Paradigm]) -> list[Paradigm]:
    """Etymologies often share a table, or one lists a few more forms (acacia: acaciae);
    keep one table, the fullest, per homonym."""

    def forms(p: Paradigm) -> frozenset[tuple[str, tuple[tuple[str, object], ...]]]:
        return frozenset((f["form"], tuple(sorted(f["feats"].items()))) for f in p["forms"])

    kept: list[Paradigm] = []
    for i, paradigm in enumerate(paradigms):
        mine = forms(paradigm)
        covered = any(
            other["homonym"] == paradigm["homonym"]
            and (mine < forms(other) or (mine == forms(other) and j < i))
            for j, other in enumerate(paradigms)
            if j != i
        )
        if not covered:
            kept.append(paradigm)
    return kept


def _lift_shared_when(senses: list[Sense]) -> Feats:
    """A selector that every sense shares (pani: always Fem) can't pick between them, so it
    comes off them; one set of features is the word's grammar."""
    selectors = [s.get("when") for s in senses]
    if not all(selector == selectors[0] for selector in selectors):
        return {}
    for sense in senses:
        sense.pop("when", None)
    match selectors[0]:
        case [feats]:
            return feats
        case _:
            return {}


type Pronunciations = dict[tuple[str, Upos], list[Pronunciation]]
type Recordings = dict[tuple[str, Upos], list[Recording]]


class VerbDerivative(NamedTuple):
    """A perfective verb Wiktionary lists among another's derived terms: zgolić under golić."""

    base: str
    derivative: str


@dataclass(frozen=True)
class Extract:
    """What one pass over a Kaikki extract finds."""

    read: int
    """Kaikki entries read."""
    converted: list[Converted]
    """The entries the analyser looks up, in the extract's order."""
    pronunciations: Pronunciations
    """By spelling and part of speech: inflected forms have them too."""
    recordings: Recordings
    derivatives: list[VerbDerivative]


def read(source: LexiconSource, path: Path) -> Extract:
    converted: list[Converted] = []
    pronunciations: Pronunciations = {}
    recordings: Recordings = {}
    derivatives: list[VerbDerivative] = []
    count = 0
    for entry in kaikki.read(path):
        count += 1
        derivatives.extend(_verb_derivatives(entry))
        if (said := source.pronounce(entry)) is not None:
            _add_said(said, pronunciations, recordings)
        if (result := source.convert(entry)) is not None:
            converted.append(result)
    return Extract(count, converted, pronunciations, recordings, derivatives)


def _add_said(said: Pronounced, pronunciations: Pronunciations, recordings: Recordings) -> None:
    for upos in said.upos:
        key = (said.word, upos)
        if said.pronunciations:
            pronunciations[key] = merge_pronunciations(
                pronunciations.get(key, []), said.pronunciations
            )
        if said.recordings:
            recordings[key] = merge_recordings(recordings.get(key, []), said.recordings)


def _verb_derivatives(entry: kaikki.KaikkiEntry) -> Iterator[VerbDerivative]:
    base = entry.get("word", "")
    if entry.get("pos") != "verb" or not base or " " in base:
        return
    for sense in entry.get("senses", []):
        for relation in sense.get("derived", []):
            word = relation.get("word", "")
            tags = relation.get("tags", [])
            if (
                word
                and word != base
                and " " not in word
                and "perfective" in tags
                and "verb" in tags
            ):
                yield VerbDerivative(base, word)


def rows(
    lang: str,
    source: LexiconSource,
    converted: Iterable[Converted],
    derivatives: Iterable[VerbDerivative] = (),
) -> list[Row]:
    """The merged entries, the source's hand entries and the verbs the others name, by
    lemma_id; an entry the analyser has no lemma_id for is left out. Their relations name
    their targets' entries, and a derivative is derived-from its base. Paradigms are the
    source's (Wiktionary's): a language that generates them does when the entry is made."""
    merged = merge(converted, source.grammar_tags)
    for hand in source.hand_entries():
        for upos in hand.upos:
            merged.setdefault(
                (hand.lemma, upos),
                Merged(hand.lemma, upos, hand.senses, hand.relations, hand.paradigms),
            )
    for verb in _named_verbs(merged.values(), derivatives):
        merged.setdefault((verb, "VERB"), Merged(verb, "VERB"))
    by_id = sorted(
        (
            (entry_id, entry)
            for (lemma, upos), entry in merged.items()
            if (entry_id := lemma_id(lang, lemma, upos)) is not None
        ),
        key=lambda pair: pair[0],
    )
    with_senses: dict[str, list[str]] = {}
    for entry_id, entry in by_id:
        if entry.senses:
            with_senses.setdefault(entry.lemma, []).append(entry_id)
    relations = {
        entry_id: [_resolved(lang, relation, with_senses) for relation in entry.relations]
        for entry_id, entry in by_id
    }
    for base, derivative in dict.fromkeys(derivatives):
        _add_derived_from(relations[_verb_id(lang, derivative)], base, _verb_id(lang, base))
    return [
        Row(
            entry_id,
            entry.lemma,
            entry.upos,
            [_sense(sense) for sense in entry.senses],
            relations[entry_id],
            entry.paradigms,
            entry.grammar,
        )
        for entry_id, entry in by_id
    ]


def _named_verbs(entries: Iterable[Merged], derivatives: Iterable[VerbDerivative]) -> list[str]:
    """Verbs Wiktionary names only in another's entry, as an aspect partner or a derived
    term (zgolić under golić), which get an entry without senses."""
    partners = [
        relation["lemma"]
        for entry in entries
        for relation in entry.relations
        if relation["kind"] == "aspect-partner"
    ]
    return partners + [verb for d in derivatives for verb in (d.derivative, d.base)]


def _verb_id(lang: str, lemma: str) -> str:
    return f"{lang}:{lemma}:VERB"


def _resolved(lang: str, relation: Relation, with_senses: Mapping[str, list[str]]) -> Relation:
    """The relation naming its target's entry: an aspect partner's is its verb; another's
    is the one entry with senses spelled like it, if there's one."""
    match relation["kind"]:
        case "aspect-partner":
            target: str | None = _verb_id(lang, relation["lemma"])
        case "derived-from" | "variant-of":
            matches = with_senses.get(relation["lemma"], [])
            target = matches[0] if len(matches) == 1 else None
        case _:
            assert_never(relation["kind"])
    data = store.relation_data(relation)
    resolved = cast(Relation, {"kind": relation["kind"], "lemma": relation["lemma"], **data})
    if target is not None:
        resolved["lemma_id"] = target
    return resolved


def _add_derived_from(relations: list[Relation], base: str, base_id: str) -> None:
    """A derivative is derived-from its whole base, unless it says so already. Not from
    the sense Kaikki lists it under: it gives a page's derived terms to the sense before the
    list, so zgolić came under golić's "to down, to soak (to drink)", not "to shave"."""
    if not any(r["kind"] == "derived-from" and r.get("lemma_id") == base_id for r in relations):
        relations.append(
            {"kind": "derived-from", "lemma": base, "how": "perfective", "lemma_id": base_id}
        )


def _sense(sense: Sense) -> Sense:
    """Only Sense's keys, in its order, without an empty selector or example list."""
    kept: Sense = {"gloss": sense["gloss"], "tags": sense["tags"]}
    if when := sense.get("when"):
        kept["when"] = when
    if examples := sense.get("examples"):
        kept["examples"] = [_example(example) for example in examples]
    return kept


def _example(example: Example) -> Example:
    kept: Example = {"text": example["text"]}
    if (translation := example.get("translation")) is not None:
        kept["translation"] = translation
    return kept


@dataclass(frozen=True)
class Inputs:
    kaikki: Path
    """Kaikki's extract for the language, e.g. kaikki.org-dictionary-Polish.jsonl."""
    commons: Path | None = None
    """A snapshot of Commons' recordings' file names (commons.fetch)."""


def build(
    lang: str, source: LexiconSource, inputs: Inputs, frames: Frames = no_frames
) -> tuple[store.Contents, Stats]:
    extract = read(source, inputs.kaikki)
    by_word = commons.recordings(lang, commons.read(inputs.commons)) if inputs.commons else {}
    built = rows(lang, source, extract.converted, extract.derivatives)
    by_id = {row.lemma_id: row for row in built}
    feats = FeatsTable()
    entries = [
        _entry_row(by_id, row._replace(paradigms=paradigms), frames, feats)
        for row in built
        for paradigms in [row.paradigms or source.paradigms(row.lemma, row.upos)]
    ]
    meta = {"lang": lang, "version": _version(source, inputs), "attribution": source.attribution}
    contents = store.Contents(
        meta,
        entries,
        _edges(built),
        feats.table,
        _audio(extract.pronunciations, extract.recordings, by_word),
    )
    stats = Stats(
        entries=extract.read,
        skipped=extract.read - len(extract.converted),
        pronounced=len(extract.pronunciations),
        recorded=len(extract.recordings),
        commons=len(by_word),
    )
    return contents, stats


def _entry_row(
    rows: Mapping[str, Row], row: Row, frames: Frames, feats: FeatsTable
) -> store.EntryRow:
    data = store.to_json(make(rows, row, frames, feats))
    return store.EntryRow(row.lemma_id, row.lemma, row.upos, data, len(row.senses))


def _edges(built: Iterable[Row]) -> list[store.Edge]:
    return [
        store.Edge(
            row.lemma_id,
            index,
            relation["lemma"],
            relation.get("lemma_id"),
            relation["kind"],
            json.dumps(store.relation_data(relation), ensure_ascii=False),
        )
        for row in built
        for index, relation in enumerate(row.relations)
    ]


def _audio(
    pronunciations: Pronunciations,
    recordings: Recordings,
    by_word: Mapping[str, list[Recording]],
) -> list[store.AudioRow]:
    """Each spelling's pronunciations and recordings by part of speech, and Commons'
    recordings of it, whatever its part of speech, under none. The lexicon Worker picks
    among them for a form (lexicon/src/store.ts)."""
    said = [
        store.AudioRow(
            form,
            upos,
            store.to_json(
                {
                    "pronunciations": pronunciations.get((form, upos), []),
                    "recordings": recordings.get((form, upos), []),
                }
            ),
        )
        for form, upos in sorted(pronunciations.keys() | recordings.keys())
    ]
    heard = [
        store.AudioRow(form, None, store.to_json({"pronunciations": [], "recordings": found}))
        for form, found in sorted(by_word.items())
        if found
    ]
    return said + heard


def _version(source: LexiconSource, inputs: Inputs) -> str:
    # Named by content: kaikki.org overwrites its extract in place, and a download's
    # mtime is the day it was fetched, so a date would differ between machines
    version = f"{LEXICON_VERSION}+kaikki-{_sha256(inputs.kaikki)[:12]}"
    if source.version:
        version += f"+{source.version}"
    if inputs.commons is not None:
        version += f"+commons-{_sha256(inputs.commons)[:12]}"
    return version


def _sha256(path: Path) -> str:
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()
