"""The lexicon on the server: one SQLite file per language, one row per lemma_id.

Ordered child tables store senses, paradigms and audio. Relations are indexed at both
ends, including references to spellings that have no entry in this lexicon.
"""

import json
import sqlite3
from collections.abc import Callable, Iterable, Iterator, Mapping
from pathlib import Path
from typing import NamedTuple, cast

from ..schema import Feats, Upos
from .schema import (
    Accent,
    Example,
    Form,
    Paradigm,
    Pronunciation,
    Recording,
    Relation,
    RelationType,
    Sense,
)

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE entry (
    lemma_id TEXT PRIMARY KEY,
    lemma TEXT NOT NULL,
    lemma_lower TEXT NOT NULL,
    upos TEXT
);
CREATE INDEX entry_lemma ON entry (lemma);
CREATE INDEX entry_lemma_lower ON entry (lemma_lower);
CREATE TABLE sense (
    id INTEGER PRIMARY KEY,
    lemma_id TEXT NOT NULL REFERENCES entry,
    ord INTEGER NOT NULL,
    gloss TEXT NOT NULL,
    tags TEXT NOT NULL CHECK (json_valid(tags) AND json_type(tags) = 'array'),
    UNIQUE (lemma_id, ord)
);
CREATE TABLE sense_when (
    sense_id INTEGER NOT NULL REFERENCES sense,
    ord INTEGER NOT NULL,
    features TEXT NOT NULL CHECK (json_valid(features) AND json_type(features) = 'object'),
    PRIMARY KEY (sense_id, ord)
) WITHOUT ROWID;
CREATE TABLE example (
    sense_id INTEGER NOT NULL REFERENCES sense,
    ord INTEGER NOT NULL,
    text TEXT NOT NULL,
    translation TEXT,
    PRIMARY KEY (sense_id, ord)
) WITHOUT ROWID;
CREATE TABLE relation (
    source_id TEXT NOT NULL REFERENCES entry,
    ord INTEGER NOT NULL,
    target_id TEXT NOT NULL REFERENCES entry,
    kind TEXT NOT NULL,
    note TEXT,
    evidence TEXT CHECK (
        evidence IS NULL OR (json_valid(evidence) AND json_type(evidence) = 'array')
    ),
    PRIMARY KEY (source_id, ord)
) WITHOUT ROWID;
CREATE INDEX relation_target ON relation (target_id, source_id, ord);
CREATE TABLE paradigm (
    id INTEGER PRIMARY KEY,
    lemma_id TEXT NOT NULL REFERENCES entry,
    ord INTEGER NOT NULL,
    homonym TEXT NOT NULL,
    UNIQUE (lemma_id, ord)
);
CREATE TABLE paradigm_form (
    paradigm_id INTEGER NOT NULL REFERENCES paradigm,
    ord INTEGER NOT NULL,
    form TEXT NOT NULL,
    xpos TEXT NOT NULL,
    features TEXT NOT NULL CHECK (json_valid(features) AND json_type(features) = 'object'),
    PRIMARY KEY (paradigm_id, ord)
) WITHOUT ROWID;
CREATE TABLE pronunciation (
    word TEXT NOT NULL,
    upos TEXT NOT NULL,
    ord INTEGER NOT NULL,
    ipa TEXT NOT NULL,
    accents TEXT CHECK (accents IS NULL OR (json_valid(accents) AND json_type(accents) = 'array')),
    PRIMARY KEY (word, upos, ord)
) WITHOUT ROWID;
CREATE TABLE recording (
    id INTEGER PRIMARY KEY,
    word TEXT NOT NULL,
    upos TEXT,
    ord INTEGER NOT NULL,
    audio TEXT NOT NULL,
    mp3_url TEXT NOT NULL,
    tags TEXT CHECK (tags IS NULL OR (json_valid(tags) AND json_type(tags) = 'array'))
);
CREATE INDEX recording_word ON recording (word, upos, ord);
"""


class Row(NamedTuple):
    lemma_id: str
    lemma: str
    upos: Upos
    senses: list[Sense]
    relations: list[Relation]
    paradigms: list[Paradigm]


class PronunciationRow(NamedTuple):
    word: str
    """As written, an inflected form or a lemma: psa, pies."""
    upos: Upos
    pronunciations: list[Pronunciation]
    recordings: list[Recording]


class VerbDerivative(NamedTuple):
    lang: str
    base: str
    derivative: str
    glosses: tuple[str, ...]


def write(
    path: Path,
    rows: Iterable[Row],
    meta: dict[str, str],
    pronunciations: Callable[[], Iterable[PronunciationRow]] = lambda: (),
    recordings: Mapping[str, list[Recording]] | None = None,
    derivatives: Iterable[VerbDerivative] = (),
) -> int:
    """pronunciations is called after rows is used up: the build collects both in one pass
    over the Kaikki extract. recordings are Commons' by word (commons.py), for any part of
    speech."""
    path.unlink(missing_ok=True)
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA)
        db.executemany("INSERT INTO meta VALUES (?, ?)", meta.items())
        count = 0
        relations: list[tuple[str, int, Relation]] = []
        for row in rows:
            db.execute(
                "INSERT INTO entry VALUES (?, ?, ?, ?)",
                (row.lemma_id, row.lemma, row.lemma.lower(), row.upos),
            )
            for index, sense in enumerate(row.senses):
                sense_id = db.execute(
                    """
                    INSERT INTO sense (lemma_id, ord, gloss, tags) VALUES (?, ?, ?, ?)
                    """,
                    (row.lemma_id, index, sense["gloss"], json.dumps(sense["tags"])),
                ).lastrowid
                db.executemany(
                    "INSERT INTO sense_when VALUES (?, ?, ?)",
                    (
                        (sense_id, index, json.dumps(feats))
                        for index, feats in enumerate(sense.get("when", []))
                    ),
                )
                db.executemany(
                    "INSERT INTO example VALUES (?, ?, ?, ?)",
                    (
                        (sense_id, index, example["text"], example.get("translation"))
                        for index, example in enumerate(sense.get("examples", []))
                    ),
                )
            relations.extend(
                (row.lemma_id, index, relation) for index, relation in enumerate(row.relations)
            )
            for index, paradigm in enumerate(row.paradigms):
                paradigm_id = db.execute(
                    "INSERT INTO paradigm (lemma_id, ord, homonym) VALUES (?, ?, ?)",
                    (row.lemma_id, index, paradigm["homonym"]),
                ).lastrowid
                db.executemany(
                    "INSERT INTO paradigm_form VALUES (?, ?, ?, ?, ?)",
                    (
                        (paradigm_id, index, form["form"], form["xpos"], json.dumps(form["feats"]))
                        for index, form in enumerate(paradigm["forms"])
                    ),
                )
            count += 1
        db.executemany(
            "INSERT INTO relation (source_id, ord, target_id, kind, note) VALUES (?, ?, ?, ?, ?)",
            (
                (
                    source_id,
                    ord_,
                    _target(db, source_id, relation),
                    relation["type"],
                    relation.get("note"),
                )
                for source_id, ord_, relation in relations
            ),
        )
        _write_derivatives(db, derivatives)
        for found in pronunciations():
            for index, pronunciation in enumerate(found.pronunciations):
                accents = pronunciation.get("accents")
                db.execute(
                    """
                    INSERT INTO pronunciation (word, upos, ord, ipa, accents)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        found.word,
                        found.upos,
                        index,
                        pronunciation["ipa"],
                        json.dumps(accents) if accents is not None else None,
                    ),
                )
            _write_recordings(db, found.word, found.upos, found.recordings)
        for word, found_recordings in sorted((recordings or {}).items()):
            _write_recordings(db, word, None, found_recordings)
    return count


def _target(db: sqlite3.Connection, source_id: str, relation: Relation) -> str:
    """Use the known part of speech, an unambiguous definition, or a spelling-only node."""
    lang = source_id.split(":", 1)[0]
    lemma = relation["lemma"]
    upos = "VERB" if relation["type"] == "aspect-partner" else None
    if upos is None:
        matches = db.execute(
            """
            SELECT entry.lemma_id FROM entry
            WHERE lemma = ? AND EXISTS (SELECT 1 FROM sense WHERE sense.lemma_id = entry.lemma_id)
            LIMIT 2
            """,
            (lemma,),
        ).fetchall()
        if len(matches) == 1:
            return cast(str, matches[0][0])
    return _ensure_entry(db, lang, lemma, upos)


def _ensure_entry(db: sqlite3.Connection, lang: str, lemma: str, upos: Upos | None) -> str:
    lemma_id = f"{lang}:{lemma}:{upos or ''}"
    db.execute(
        "INSERT INTO entry VALUES (?, ?, ?, ?) ON CONFLICT (lemma_id) DO NOTHING",
        (lemma_id, lemma, lemma.lower(), upos),
    )
    return lemma_id


def _write_derivatives(db: sqlite3.Connection, derivatives: Iterable[VerbDerivative]) -> None:
    evidence: dict[tuple[str, str], list[tuple[str, ...]]] = {}
    for lang, base, derivative, glosses in derivatives:
        source_id = _ensure_entry(db, lang, derivative, "VERB")
        target_id = _ensure_entry(db, lang, base, "VERB")
        senses = evidence.setdefault((source_id, target_id), [])
        if glosses and glosses not in senses:
            senses.append(glosses)
    for (source_id, target_id), senses in evidence.items():
        found = db.execute(
            """
            SELECT ord FROM relation
            WHERE source_id = ? AND target_id = ? AND kind = 'derived-from'
            ORDER BY ord LIMIT 1
            """,
            (source_id, target_id),
        ).fetchone()
        if found:
            db.execute(
                "UPDATE relation SET evidence = ? WHERE source_id = ? AND ord = ?",
                (json.dumps(senses, ensure_ascii=False), source_id, found[0]),
            )
        else:
            db.execute(
                """
                INSERT INTO relation (source_id, ord, target_id, kind, note, evidence)
                SELECT ?, coalesce(max(ord), -1) + 1, ?, 'derived-from', 'perfective derivative', ?
                FROM relation WHERE source_id = ?
                """,
                (source_id, target_id, json.dumps(senses, ensure_ascii=False), source_id),
            )


def _write_recordings(
    db: sqlite3.Connection, word: str, upos: Upos | None, recordings: Iterable[Recording]
) -> None:
    for index, recording in enumerate(recordings):
        tags = recording.get("tags")
        db.execute(
            """
            INSERT INTO recording (word, upos, ord, audio, mp3_url, tags)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                word,
                upos,
                index,
                recording["audio"],
                recording["mp3_url"],
                json.dumps(tags) if tags is not None else None,
            ),
        )


class Lexicon:
    def __init__(self, path: Path) -> None:
        self._db = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)

    def meta(self) -> dict[str, str]:
        return dict(self._db.execute("SELECT key, value FROM meta").fetchall())

    def version(self) -> str:
        """The lexicon's version: its sources and their dates. Bundle names depend on it,
        so a lexicon without one is refused."""
        version = self.meta().get("version")
        if not version:
            raise ValueError("the lexicon has no version in its meta table")
        return version

    def get(self, lemma_id: str) -> Row | None:
        found = self._select("WHERE lemma_id = ?", lemma_id)
        return next(found, None)

    def by_lemma(self, lemma: str) -> list[Row]:
        """Every part of speech filed under this lemma, most senses first."""
        return sorted(self._select("WHERE lemma = ?", lemma), key=lambda r: -len(r.senses))

    def by_lowercase(self, lemma: str) -> list[Row]:
        rows = self._select("WHERE lemma_lower = ?", lemma.lower())
        return sorted(rows, key=lambda r: -len(r.senses))

    def incoming(self, lemma: str) -> Iterator[tuple[str, Relation]]:
        """Stored relations pointing to a spelling, even if it has no entry."""
        for source_id, kind, note in self._db.execute(
            """
            SELECT relation.source_id, relation.kind, relation.note
            FROM entry AS target JOIN relation ON relation.target_id = target.lemma_id
            WHERE target.lemma = ? ORDER BY relation.source_id, relation.ord
            """,
            (lemma,),
        ):
            yield source_id, _relation(kind, lemma, note)

    def pronunciations(self, word: str) -> dict[Upos, list[Pronunciation]]:
        """By part of speech: lead is /lɛd/ as a noun, /liːd/ as a verb."""
        result: dict[Upos, list[Pronunciation]] = {}
        for upos, ipa, accents in self._db.execute(
            "SELECT upos, ipa, accents FROM pronunciation WHERE word = ? ORDER BY upos, ord",
            (word,),
        ):
            pronunciation: Pronunciation = {"ipa": ipa}
            if accents is not None:
                pronunciation["accents"] = cast(list[Accent], json.loads(accents))
            result.setdefault(cast(Upos, upos), []).append(pronunciation)
        return result

    def recordings(self, word: str) -> dict[Upos, list[Recording]]:
        result: dict[Upos, list[Recording]] = {}
        for upos, recording in self._recordings(word, commons=False):
            result.setdefault(cast(Upos, upos), []).append(recording)
        return result

    def word_recordings(self, word: str) -> list[Recording]:
        """Commons' recordings of the spelling, whatever its part of speech."""
        return [recording for _, recording in self._recordings(word, commons=True)]

    def _recordings(self, word: str, *, commons: bool) -> Iterator[tuple[Upos | None, Recording]]:
        condition = "IS NULL" if commons else "IS NOT NULL"
        for upos, audio, mp3_url, tags in self._db.execute(
            f"""
            SELECT upos, audio, mp3_url, tags FROM recording
            WHERE word = ? AND upos {condition} ORDER BY upos, ord
            """,
            (word,),
        ):
            recording: Recording = {"audio": audio, "mp3_url": mp3_url}
            if tags is not None:
                recording["tags"] = cast(list[str], json.loads(tags))
            yield upos, recording

    def rows(self) -> Iterator[Row]:
        """Every entry, by lemma_id."""
        return self._select("ORDER BY lemma_id")

    def _select(self, where: str, *values: str) -> Iterator[Row]:
        for lemma_id, lemma, upos in self._db.execute(
            f"SELECT lemma_id, lemma, upos FROM entry {where}", values
        ):
            if upos is None:
                continue
            yield Row(
                lemma_id,
                lemma,
                upos,
                list(self._senses(lemma_id)),
                [
                    _relation(kind, target, note)
                    for kind, target, note in self._db.execute(
                        """
                        SELECT relation.kind, target.lemma, relation.note
                        FROM relation JOIN entry AS target ON target.lemma_id = relation.target_id
                        WHERE relation.source_id = ? ORDER BY relation.ord
                        """,
                        (lemma_id,),
                    )
                ],
                list(self._paradigms(lemma_id)),
            )

    def _senses(self, lemma_id: str) -> Iterator[Sense]:
        for id_, gloss, tags in self._db.execute(
            "SELECT id, gloss, tags FROM sense WHERE lemma_id = ? ORDER BY ord", (lemma_id,)
        ):
            sense: Sense = {"gloss": gloss, "tags": json.loads(tags)}
            selectors = [
                cast(Feats, json.loads(features))
                for (features,) in self._db.execute(
                    "SELECT features FROM sense_when WHERE sense_id = ? ORDER BY ord", (id_,)
                )
            ]
            if selectors:
                sense["when"] = selectors
            examples: list[Example] = []
            for text, translation in self._db.execute(
                "SELECT text, translation FROM example WHERE sense_id = ? ORDER BY ord", (id_,)
            ):
                example: Example = {"text": text}
                if translation is not None:
                    example["translation"] = translation
                examples.append(example)
            if examples:
                sense["examples"] = examples
            yield sense

    def _paradigms(self, lemma_id: str) -> Iterator[Paradigm]:
        for id_, homonym in self._db.execute(
            "SELECT id, homonym FROM paradigm WHERE lemma_id = ? ORDER BY ord", (lemma_id,)
        ):
            forms: list[Form] = [
                {"form": form, "xpos": xpos, "feats": json.loads(features)}
                for form, xpos, features in self._db.execute(
                    """
                    SELECT form, xpos, features FROM paradigm_form
                    WHERE paradigm_id = ? ORDER BY ord
                    """,
                    (id_,),
                )
            ]
            yield {"homonym": homonym, "forms": forms}


def _relation(kind: RelationType, lemma: str, note: str | None) -> Relation:
    result: Relation = {"type": kind, "lemma": lemma}
    if note is not None:
        result["note"] = note
    return result
