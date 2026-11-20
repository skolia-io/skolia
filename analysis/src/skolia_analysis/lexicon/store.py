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
    upos TEXT NOT NULL
);
CREATE INDEX entry_lemma ON entry (lemma);
CREATE INDEX entry_lemma_lower ON entry (lemma_lower);
CREATE TABLE sense (
    id INTEGER PRIMARY KEY,
    lemma_id TEXT NOT NULL REFERENCES entry,
    ord INTEGER NOT NULL,
    gloss TEXT NOT NULL,
    has_when INTEGER NOT NULL CHECK (has_when IN (0, 1)),
    has_examples INTEGER NOT NULL CHECK (has_examples IN (0, 1)),
    UNIQUE (lemma_id, ord)
);
CREATE TABLE sense_tag (
    sense_id INTEGER NOT NULL REFERENCES sense,
    ord INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (sense_id, ord)
) WITHOUT ROWID;
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
    target_lemma TEXT NOT NULL,
    kind TEXT NOT NULL,
    note TEXT,
    PRIMARY KEY (source_id, ord)
) WITHOUT ROWID;
CREATE INDEX relation_target ON relation (target_lemma, source_id, ord);
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
    id INTEGER PRIMARY KEY,
    word TEXT NOT NULL,
    upos TEXT NOT NULL,
    ord INTEGER NOT NULL,
    ipa TEXT NOT NULL,
    has_accents INTEGER NOT NULL CHECK (has_accents IN (0, 1)),
    UNIQUE (word, upos, ord)
);
CREATE TABLE pronunciation_accent (
    pronunciation_id INTEGER NOT NULL REFERENCES pronunciation,
    ord INTEGER NOT NULL,
    accent TEXT NOT NULL,
    PRIMARY KEY (pronunciation_id, ord)
) WITHOUT ROWID;
CREATE TABLE recording (
    id INTEGER PRIMARY KEY,
    word TEXT NOT NULL,
    upos TEXT,
    ord INTEGER NOT NULL,
    audio TEXT NOT NULL,
    mp3_url TEXT NOT NULL,
    has_tags INTEGER NOT NULL CHECK (has_tags IN (0, 1))
);
CREATE INDEX recording_word ON recording (word, upos, ord);
CREATE TABLE recording_tag (
    recording_id INTEGER NOT NULL REFERENCES recording,
    ord INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (recording_id, ord)
) WITHOUT ROWID;
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


def write(
    path: Path,
    rows: Iterable[Row],
    meta: dict[str, str],
    pronunciations: Callable[[], Iterable[PronunciationRow]] = lambda: (),
    recordings: Mapping[str, list[Recording]] | None = None,
) -> int:
    """pronunciations is called after rows is used up: the build collects both in one pass
    over the Kaikki extract. recordings are Commons' by word (commons.py), for any part of
    speech."""
    path.unlink(missing_ok=True)
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA)
        db.executemany("INSERT INTO meta VALUES (?, ?)", meta.items())
        count = 0
        for row in rows:
            db.execute(
                "INSERT INTO entry VALUES (?, ?, ?, ?)",
                (row.lemma_id, row.lemma, row.lemma.lower(), row.upos),
            )
            for index, sense in enumerate(row.senses):
                sense_id = db.execute(
                    """
                    INSERT INTO sense (lemma_id, ord, gloss, has_when, has_examples)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (row.lemma_id, index, sense["gloss"], "when" in sense, "examples" in sense),
                ).lastrowid
                db.executemany(
                    "INSERT INTO sense_tag VALUES (?, ?, ?)",
                    ((sense_id, index, tag) for index, tag in enumerate(sense["tags"])),
                )
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
            db.executemany(
                "INSERT INTO relation VALUES (?, ?, ?, ?, ?)",
                (
                    (row.lemma_id, index, relation["lemma"], relation["type"], relation.get("note"))
                    for index, relation in enumerate(row.relations)
                ),
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
        for found in pronunciations():
            for index, pronunciation in enumerate(found.pronunciations):
                pronunciation_id = db.execute(
                    """
                    INSERT INTO pronunciation (word, upos, ord, ipa, has_accents)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        found.word,
                        found.upos,
                        index,
                        pronunciation["ipa"],
                        "accents" in pronunciation,
                    ),
                ).lastrowid
                db.executemany(
                    "INSERT INTO pronunciation_accent VALUES (?, ?, ?)",
                    (
                        (pronunciation_id, index, accent)
                        for index, accent in enumerate(pronunciation.get("accents", []))
                    ),
                )
            _write_recordings(db, found.word, found.upos, found.recordings)
        for word, found_recordings in sorted((recordings or {}).items()):
            _write_recordings(db, word, None, found_recordings)
    return count


def _write_recordings(
    db: sqlite3.Connection, word: str, upos: Upos | None, recordings: Iterable[Recording]
) -> None:
    for index, recording in enumerate(recordings):
        recording_id = db.execute(
            """
            INSERT INTO recording (word, upos, ord, audio, mp3_url, has_tags)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (word, upos, index, recording["audio"], recording["mp3_url"], "tags" in recording),
        ).lastrowid
        db.executemany(
            "INSERT INTO recording_tag VALUES (?, ?, ?)",
            ((recording_id, index, tag) for index, tag in enumerate(recording.get("tags", []))),
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
            SELECT source_id, kind, note FROM relation
            WHERE target_lemma = ? ORDER BY source_id, ord
            """,
            (lemma,),
        ):
            yield source_id, _relation(kind, lemma, note)

    def pronunciations(self, word: str) -> dict[Upos, list[Pronunciation]]:
        """By part of speech: lead is /lɛd/ as a noun, /liːd/ as a verb."""
        result: dict[Upos, list[Pronunciation]] = {}
        for upos, id_, ipa, has_accents in self._db.execute(
            "SELECT upos, id, ipa, has_accents FROM pronunciation "
            "WHERE word = ? ORDER BY upos, ord",
            (word,),
        ):
            pronunciation: Pronunciation = {"ipa": ipa}
            if has_accents:
                pronunciation["accents"] = [
                    cast(Accent, accent)
                    for (accent,) in self._db.execute(
                        "SELECT accent FROM pronunciation_accent "
                        "WHERE pronunciation_id = ? ORDER BY ord",
                        (id_,),
                    )
                ]
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
        for upos, id_, audio, mp3_url, has_tags in self._db.execute(
            f"""
            SELECT upos, id, audio, mp3_url, has_tags FROM recording
            WHERE word = ? AND upos {condition} ORDER BY upos, ord
            """,
            (word,),
        ):
            recording: Recording = {"audio": audio, "mp3_url": mp3_url}
            if has_tags:
                recording["tags"] = [
                    tag
                    for (tag,) in self._db.execute(
                        "SELECT tag FROM recording_tag WHERE recording_id = ? ORDER BY ord",
                        (id_,),
                    )
                ]
            yield upos, recording

    def rows(self) -> Iterator[Row]:
        """Every entry, by lemma_id."""
        return self._select("ORDER BY lemma_id")

    def _select(self, where: str, *values: str) -> Iterator[Row]:
        for lemma_id, lemma, upos in self._db.execute(
            f"SELECT lemma_id, lemma, upos FROM entry {where}", values
        ):
            yield Row(
                lemma_id,
                lemma,
                upos,
                list(self._senses(lemma_id)),
                [
                    _relation(kind, target, note)
                    for kind, target, note in self._db.execute(
                        "SELECT kind, target_lemma, note FROM relation "
                        "WHERE source_id = ? ORDER BY ord",
                        (lemma_id,),
                    )
                ],
                list(self._paradigms(lemma_id)),
            )

    def _senses(self, lemma_id: str) -> Iterator[Sense]:
        for id_, gloss, has_when, has_examples in self._db.execute(
            "SELECT id, gloss, has_when, has_examples FROM sense WHERE lemma_id = ? ORDER BY ord",
            (lemma_id,),
        ):
            sense: Sense = {
                "gloss": gloss,
                "tags": [
                    tag
                    for (tag,) in self._db.execute(
                        "SELECT tag FROM sense_tag WHERE sense_id = ? ORDER BY ord", (id_,)
                    )
                ],
            }
            if has_when:
                sense["when"] = [
                    cast(Feats, json.loads(features))
                    for (features,) in self._db.execute(
                        "SELECT features FROM sense_when WHERE sense_id = ? ORDER BY ord",
                        (id_,),
                    )
                ]
            if has_examples:
                examples: list[Example] = []
                for text, translation in self._db.execute(
                    "SELECT text, translation FROM example WHERE sense_id = ? ORDER BY ord",
                    (id_,),
                ):
                    example: Example = {"text": text}
                    if translation is not None:
                        example["translation"] = translation
                    examples.append(example)
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
