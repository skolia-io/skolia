"""The API's D1 lexicon (LEXICON_{LANG}) as a SQLite file: one version's rows in D1's own
schema, made by applying api/lexicon-migrations in order, plus a meta table with the
language and version. infra/load-lexicon.py copies the rows into D1.

Entries and relations are the lexicon's graph: a spelling a relation points at that has no
entry is a node with no upos. Each entry has its lemma's pronunciations and its paradigms in
the bundle's compact form,
whose forms are ["psa", [1, 3]]: psa is feature sets 1 and 3, genitive and accusative
singular. Set 1 is the rows (1, Case, Gen), (1, Number, Sing), ... in featureset.
"""

import json
import sqlite3
from collections.abc import Callable
from pathlib import Path

from ..schema import Feats, Upos
from .bundle import FeatsTable, compact, pronounce
from .schema import Paradigm
from .store import Lexicon

EXPORT_VERSION = 2
"""Goes up when what this adds to an entry changes, so every environment loads it again."""

type Paradigms = Callable[[str, Upos], list[Paradigm]]


def version(lexicon: Lexicon) -> str:
    return f"{lexicon.version()}+d1-{EXPORT_VERSION}"


def build(lexicon: Lexicon, paradigms: Paradigms | None, migrations: Path, out: Path) -> int:
    """paradigms generates a lemma's, for a language whose lexicon stores none (Polish).
    migrations is api/lexicon-migrations."""
    table: list[Feats] = []
    feats = FeatsTable(table)
    built = version(lexicon)
    out.unlink(missing_ok=True)
    count = 0
    with sqlite3.connect(out) as db:
        for migration in sorted(migrations.glob("*.sql")):
            db.executescript(migration.read_text())
        db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        meta = {**lexicon.meta(), "version": built}
        db.executemany("INSERT INTO meta VALUES (?, ?)", meta.items())
        insert = """
            INSERT INTO entry (lemma_id, version, lemma, upos, senses, pronunciations, paradigms)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """
        for row in lexicon.rows():
            found = paradigms(row.lemma, row.upos) if paradigms else row.paradigms
            db.execute(
                insert,
                (
                    row.lemma_id,
                    built,
                    row.lemma,
                    row.upos,
                    _json(row.senses),
                    _json(pronounce(lexicon, row.lemma, row.upos)),
                    _json([compact(p, feats) for p in found]),
                ),
            )
            count += 1
        db.executemany(
            insert,
            (
                (lemma_id, built, lemma, None, "[]", "[]", "[]")
                for lemma_id, lemma in lexicon.spellings()
            ),
        )
        db.executemany(
            """
            INSERT INTO relation (source_id, version, ord, target_id, kind, note, target_senses)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (e.source_id, built, e.ord, e.target_id, e.kind, e.note, e.target_senses)
                for e in lexicon.edges()
            ),
        )
        db.executemany(
            "INSERT INTO featureset (version, id, feature, value) VALUES (?, ?, ?, ?)",
            ((built, i, k, str(v)) for i, f in enumerate(table) for k, v in f.items()),
        )
    return count


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
