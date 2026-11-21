"""Kaikki extract -> lexicon SQLite file, keyed by the analyser's lemma_id."""

import hashlib
from collections.abc import Collection, Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

from ..blob import lemma_id
from ..schema import Feats, Upos
from . import commons, kaikki, store
from .pronunciation import merge as merge_pronunciations
from .pronunciation import merge_recordings
from .schema import Paradigm, Pronunciation, Recording, Relation, Sense
from .source import Converted, LexiconSource, Pronounced

LEXICON_VERSION = "8"


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
    derivatives: list[store.VerbDerivative]


def read(lang: str, source: LexiconSource, path: Path) -> Extract:
    converted: list[Converted] = []
    pronunciations: Pronunciations = {}
    recordings: Recordings = {}
    derivatives: list[store.VerbDerivative] = []
    count = 0
    for entry in kaikki.read(path):
        count += 1
        derivatives.extend(_verb_derivatives(lang, entry))
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


def rows(lang: str, source: LexiconSource, converted: Iterable[Converted]) -> list[store.Row]:
    """The merged entries and the source's hand entries, by lemma and part of speech; an
    entry the analyser has no lemma_id for is left out."""
    merged = merge(converted, source.grammar_tags)
    for hand in source.hand_entries():
        for upos in hand.upos:
            merged.setdefault(
                (hand.lemma, upos),
                Merged(hand.lemma, upos, hand.senses, hand.relations, hand.paradigms),
            )
    return [
        store.Row(
            entry_id, lemma, upos, entry.senses, entry.relations, entry.paradigms, entry.grammar
        )
        for (lemma, upos), entry in sorted(merged.items())
        if (entry_id := lemma_id(lang, lemma, upos)) is not None
    ]


def said(extract: Extract) -> list[store.PronunciationRow]:
    """Each spelling and part of speech's pronunciations and recordings, in order."""
    return [
        store.PronunciationRow(
            word,
            upos,
            extract.pronunciations.get((word, upos), []),
            extract.recordings.get((word, upos), []),
        )
        for word, upos in sorted(extract.pronunciations.keys() | extract.recordings.keys())
    ]


def _verb_derivatives(lang: str, entry: kaikki.KaikkiEntry) -> Iterator[store.VerbDerivative]:
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
                yield store.VerbDerivative(lang, base, word)


def build(
    lang: str,
    source: LexiconSource,
    kaikki_path: Path,
    out: Path,
    commons_path: Path | None = None,
) -> tuple[int, Stats]:
    """commons_path is a snapshot of Commons' recordings' file names (commons.fetch)."""
    # Named by content: kaikki.org overwrites its extract in place, and a download's
    # mtime is the day it was fetched, so a date would differ between machines
    extract = _sha256(kaikki_path)[:12]
    lexicon_version = f"{LEXICON_VERSION}+kaikki-{extract}"
    if source.version:
        lexicon_version += f"+{source.version}"
    if commons_path is not None:
        lexicon_version += f"+commons-{_sha256(commons_path)[:12]}"
    by_word = commons.recordings(lang, commons.read(commons_path)) if commons_path else {}
    meta = {"lang": lang, "version": lexicon_version, "attribution": source.attribution}
    extract = read(lang, source, kaikki_path)
    count = store.write(
        out,
        store.Contents(
            meta,
            rows(lang, source, extract.converted),
            said(extract),
            by_word,
            extract.derivatives,
        ),
    )
    stats = Stats(
        entries=extract.read,
        skipped=extract.read - len(extract.converted),
        pronounced=len(extract.pronunciations),
        recorded=len(extract.recordings),
        commons=len(by_word),
    )
    return count, stats


def _sha256(path: Path) -> str:
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()
