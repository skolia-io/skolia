import argparse
import json
import sqlite3
import sys
from pathlib import Path

from .. import lang
from . import build, commons, store
from .store import Lexicon


def lookup_main() -> None:
    parser = argparse.ArgumentParser(
        prog="skolia-lexicon",
        description="Look up an exact lemma in a built lexicon and print JSON.",
    )
    parser.add_argument("lemma", help="headword as spelled in the lexicon, e.g. golić")
    parser.add_argument("--db", type=Path, required=True, help="path to the lexicon SQLite file")
    parser.add_argument(
        "--incoming",
        action="store_true",
        help="also show relations pointing to this lemma",
    )
    args = parser.parse_args()
    lemma: str = args.lemma
    try:
        lexicon = Lexicon(args.db.resolve())
        result: dict[str, object] = {
            "lemma": lemma,
            "entries": lexicon.by_lemma(lemma),
        }
        if args.incoming:
            result["incoming"] = [
                {"from": source_id, "relation": relation}
                for source_id, relation in lexicon.incoming(lemma)
            ]
    except sqlite3.Error as error:
        parser.exit(1, f"{parser.prog}: {args.db}: {error}\n")
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def build_main() -> None:
    parser = argparse.ArgumentParser(
        prog="skolia-build-lexicon",
        description="Build a language's lexicon from Kaikki's Wiktionary extract: a SQLite "
        "file in the lexicon Worker's D1 schema, which infra/load-lexicon.py loads.",
    )
    parser.add_argument("lang", choices=lang.LANGS)
    parser.add_argument("kaikki", type=Path, help="e.g. kaikki.org-dictionary-Polish.jsonl")
    parser.add_argument("migrations", type=Path, help="lexicon/migrations")
    parser.add_argument("out", type=Path, help="output .sqlite file (replaced)")
    parser.add_argument(
        "--commons",
        type=Path,
        help="Commons' recordings' file names, from skolia-fetch-commons (Polish only)",
    )
    parser.add_argument(
        "--data",
        type=Path,
        help="the language's data directory, for its valency frames (Polish: pl-valency.json)",
    )
    args = parser.parse_args()
    plugin = lang.plugin(args.lang)
    contents, stats = build.build(
        args.lang,
        plugin.lexicon_source(),
        build.Inputs(args.kaikki, args.commons),
        plugin.frames(args.data),
    )
    store.write(args.out, args.migrations, contents)
    print(
        f"{len(contents.entries)} lemma entries from {stats.entries} Kaikki entries "
        f"({stats.skipped} skipped: inflected forms, phrases, affixes); "
        f"{stats.pronounced} (word, part of speech) pairs with a pronunciation, "
        f"{stats.recorded} with a recording; "
        f"{stats.commons} spellings with a recording from Commons",
        file=sys.stderr,
    )


def fetch_commons_main() -> None:
    parser = argparse.ArgumentParser(
        prog="skolia-fetch-commons",
        description="Snapshot the file names of a language's recordings on Wikimedia Commons, "
        "for skolia-build-lexicon --commons. Takes a few minutes: Commons rate-limits.",
    )
    parser.add_argument("lang", choices=sorted(commons.CATEGORIES))
    parser.add_argument("out", type=Path, help="output .txt file (replaced)")
    args = parser.parse_args()
    print(f"{commons.fetch(args.lang, args.out)} files", file=sys.stderr)
