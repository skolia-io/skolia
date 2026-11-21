"""The lexicon build end to end: a small Kaikki extract per language, through build.build and
d1_export.build, against a dump of the D1 export in fixtures/lexicon/{lang}.d1.txt.
UPDATE_SNAPSHOTS=1 uv run pytest tests/test_lexicon_golden.py rewrites the snapshots."""

import os
import sqlite3
from pathlib import Path

import pytest

from skolia_analysis import lang as langs
from skolia_analysis.lexicon import build, d1_export, store

FIXTURES = Path(__file__).parent / "fixtures" / "lexicon"
MIGRATIONS = Path(__file__).resolve().parents[2] / "lexicon" / "migrations"


def dump(path: Path) -> str:
    """Every table, by name, its rows sorted by every column, one a line, cells separated by
    tabs and NULL for null. The version, which is on every row, is $VERSION but in meta."""
    db = sqlite3.connect(path)
    (version,) = db.execute("SELECT value FROM meta WHERE key = 'version'").fetchone()
    tables = [
        name
        for (name,) in db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' "
            "ORDER BY name"
        )
    ]
    lines: list[str] = []
    for table in tables:
        columns = [column for _, column, *_ in db.execute(f"PRAGMA table_info({table})")]
        order = ", ".join(str(i + 1) for i in range(len(columns)))
        lines.append(f"## {table} ({', '.join(columns)})")
        lines += [
            "\t".join(
                "NULL"
                if cell is None
                else "$VERSION"
                if cell == version and table != "meta"
                else str(cell)
                for cell in row
            )
            for row in db.execute(f"SELECT * FROM {table} ORDER BY {order}")
        ]
    db.close()
    return "\n".join(lines) + "\n"


@pytest.mark.parametrize(
    ("lang", "commons", "expected"),
    [
        ("en", False, (10, build.Stats(entries=12, skipped=2, pronounced=5, recorded=2), 10)),
        ("fr", False, (9, build.Stats(entries=13, skipped=2, pronounced=6), 9)),
        (
            "pl",
            True,
            (11, build.Stats(entries=13, skipped=2, pronounced=9, recorded=2, commons=2), 12),
        ),
    ],
)
def test_build_matches_snapshot(
    lang: str,
    commons: bool,
    expected: tuple[int, build.Stats, int],
    tmp_path: Path,
) -> None:
    if lang == "pl":
        pytest.importorskip("morfeusz2")
    plugin = langs.plugin(lang)
    lexicon = tmp_path / f"{lang}.sqlite"
    count, stats = build.build(
        lang,
        plugin.lexicon_source(),
        FIXTURES / f"{lang}.kaikki.jsonl",
        lexicon,
        FIXTURES / f"{lang}.commons.txt" if commons else None,
    )
    out = tmp_path / f"{lang}.d1.sqlite"
    exported = d1_export.build(store.Lexicon(lexicon), plugin.extras(None), MIGRATIONS, out)
    snapshot = FIXTURES / f"{lang}.d1.txt"
    if os.environ.get("UPDATE_SNAPSHOTS") == "1":
        snapshot.write_text(dump(out), encoding="utf-8")
    assert (count, stats, exported) == expected
    assert dump(out) == snapshot.read_text(encoding="utf-8")
