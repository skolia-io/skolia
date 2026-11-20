"""Prototype an indexed Polish verb graph from a built lexicon and its Kaikki extract."""

import argparse
import json
import sqlite3
from collections.abc import Iterator
from contextlib import closing
from pathlib import Path

SCHEMA = """
CREATE TABLE edge (
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (source, target, kind)
) WITHOUT ROWID;
CREATE INDEX edge_target ON edge (target, source, kind);
CREATE TABLE evidence (
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,
    headword TEXT NOT NULL,
    field TEXT NOT NULL,
    gloss TEXT NOT NULL,
    PRIMARY KEY (source, target, kind, headword, field, gloss),
    FOREIGN KEY (source, target, kind) REFERENCES edge (source, target, kind)
) WITHOUT ROWID;
"""

NEIGHBORS = """
SELECT source, target, kind FROM edge WHERE source = ?
UNION ALL
SELECT source, target, kind FROM edge WHERE target = ? AND source != ?
"""

type Evidence = tuple[str, str, str, str, str, str]


def aspect_evidence(lexicon: sqlite3.Connection) -> Iterator[Evidence]:
    for headword, relations in lexicon.execute(
        "SELECT lemma, relations FROM entry WHERE upos = 'VERB' AND relations != '[]'"
    ):
        for relation in json.loads(relations):
            if relation["type"] != "aspect-partner":
                continue
            partner = relation["lemma"]
            if relation.get("note") == "perfective":
                yield headword, partner, "aspect-partner", headword, "forms", ""
            elif relation.get("note") == "imperfective":
                yield partner, headword, "aspect-partner", headword, "forms", ""


def derivative_evidence(extract: Path) -> Iterator[Evidence]:
    with extract.open(encoding="utf-8") as lines:
        for line in lines:
            entry = json.loads(line)
            if entry.get("pos") != "verb":
                continue
            headword = entry["word"]
            for sense in entry.get("senses", []):
                for derived in sense.get("derived", []):
                    target = derived.get("word")
                    if target and target != headword and "perfective" in derived.get("tags", []):
                        gloss = " | ".join(sense.get("glosses", []))
                        yield headword, target, "perfective-derivative", headword, "derived", gloss


def inspect(lexicon: sqlite3.Connection, extract: Path, lemma: str) -> dict[str, object]:
    with closing(sqlite3.connect(":memory:")) as graph:
        graph.execute("PRAGMA foreign_keys = ON")
        graph.executescript(SCHEMA)
        for evidence in (aspect_evidence(lexicon), derivative_evidence(extract)):
            for row in evidence:
                graph.execute("INSERT OR IGNORE INTO edge VALUES (?, ?, ?)", row[:3])
                graph.execute("INSERT OR IGNORE INTO evidence VALUES (?, ?, ?, ?, ?, ?)", row)
        args = (lemma, lemma, lemma)
        neighbors = sorted(graph.execute(NEIGHBORS, args))
        nodes = {lemma} | {word for source, target, _ in neighbors for word in (source, target)}
        return {
            "counts": graph.execute(
                "SELECT kind, count(*) FROM edge GROUP BY kind ORDER BY kind"
            ).fetchall(),
            "lemma": lemma,
            "neighbors": [
                {
                    "source": source,
                    "target": target,
                    "kind": kind,
                    "evidence": graph.execute(
                        """
                        SELECT headword, field, gloss FROM evidence
                        WHERE source = ? AND target = ? AND kind = ?
                        """,
                        (source, target, kind),
                    ).fetchall(),
                }
                for source, target, kind in neighbors
            ],
            "has_definition": {
                word: lexicon.execute(
                    "SELECT 1 FROM entry WHERE lemma = ? AND upos = 'VERB'", (word,)
                ).fetchone()
                is not None
                for word in sorted(nodes)
            },
            "query_plan": [
                row[-1] for row in graph.execute("EXPLAIN QUERY PLAN " + NEIGHBORS, args)
            ],
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("lexicon", type=Path)
    parser.add_argument("extract", type=Path)
    parser.add_argument("lemma")
    args = parser.parse_args()
    with closing(
        sqlite3.connect(f"{args.lexicon.resolve().as_uri()}?mode=ro", uri=True)
    ) as lexicon:
        print(json.dumps(inspect(lexicon, args.extract, args.lemma), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
