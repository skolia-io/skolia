"""The lexicon Worker's D1 lexicon (LEXICON_{LANG}) as a SQLite file: one version's rows in
D1's own schema, made by applying lexicon/migrations in order, plus a meta table with the
language and version. infra/load-lexicon.py copies the rows into D1.

Each entry's data is the whole Entry the API serves (lexicon/entry.py), its paradigms'
forms ["psa", [1, 3]]: psa is feature sets 1 and 3, genitive and accusative singular. Set
1 is the rows (1, Case, Gen), (1, Number, Sing), ... in featureset. The relation rows are
the lexicon's graph, for finding what points at a word.
"""

import json
import sqlite3
from pathlib import Path

from ..schema import Feats
from . import entry
from .entry import Extras, FeatsTable
from .store import Lexicon

EXPORT_VERSION = 3
"""Goes up when what this adds to an entry changes, so every environment loads it again."""


def version(lexicon: Lexicon) -> str:
    return f"{lexicon.version()}+d1-{EXPORT_VERSION}"


def build(lexicon: Lexicon, extras: Extras, migrations: Path, out: Path) -> int:
    """migrations is lexicon/migrations."""
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
        for row in lexicon.rows():
            db.execute(
                "INSERT INTO entry (lemma_id, version, lemma, upos, data) VALUES (?, ?, ?, ?, ?)",
                (
                    row.lemma_id,
                    built,
                    row.lemma,
                    row.upos,
                    _json(entry.make(lexicon, row, extras, feats)),
                ),
            )
            count += 1
        db.executemany(
            """
            INSERT INTO relation (source_id, version, ord, target_lemma, target_id, kind, data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (e.source_id, built, e.ord, e.target_lemma, e.target_id, e.kind, e.data)
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
