import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import cast

from .. import lang
from ..plugin import lexicon_path
from ..schema import Blob
from . import build, commons, d1_export
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
            "entries": [row._asdict() for row in lexicon.by_lemma(lemma)],
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
        description="Build a language's lexicon SQLite file from Kaikki's Wiktionary extract.",
    )
    parser.add_argument("lang", choices=lang.LANGS)
    parser.add_argument("kaikki", type=Path, help="e.g. kaikki.org-dictionary-Polish.jsonl")
    parser.add_argument("out", type=Path, help="output .sqlite file (replaced)")
    parser.add_argument(
        "--commons",
        type=Path,
        help="Commons' recordings' file names, from skolia-fetch-commons (Polish only)",
    )
    args = parser.parse_args()
    source = lang.plugin(args.lang).lexicon_source()
    count, stats = build.build(args.lang, source, args.kaikki, args.out, args.commons)
    print(
        f"{count} lemma entries from {stats.entries} Kaikki entries "
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


def d1_export_main() -> None:
    parser = argparse.ArgumentParser(
        prog="skolia-build-d1-export",
        description="Build the API's D1 lexicon as a SQLite file in D1's schema "
        "(infra/load-lexicon.py loads it).",
    )
    parser.add_argument("lang", choices=lang.LANGS)
    parser.add_argument("lexicon", type=Path, help="{lang}.sqlite from skolia-build-lexicon")
    parser.add_argument("migrations", type=Path, help="lexicon/migrations")
    parser.add_argument("out", type=Path, help="output .sqlite file (replaced)")
    args = parser.parse_args()
    count = d1_export.build(
        Lexicon(args.lexicon), lang.plugin(args.lang).paradigms(), args.migrations, args.out
    )
    print(f"{count} entries", file=sys.stderr)


def bundle_main() -> None:
    parser = argparse.ArgumentParser(
        prog="skolia-bundle",
        description="Read an analysis blob on stdin, write the document's lexicon bundle.",
    )
    parser.add_argument(
        "--data",
        type=Path,
        required=True,
        help="the language's data directory: {lang}.sqlite and the plugin's files",
    )
    parser.add_argument("--indent", type=int, default=None)
    args = parser.parse_args()
    blob = cast(Blob, json.load(sys.stdin))
    data: Path = args.data
    lexicon = Lexicon(lexicon_path(data, blob["lang"]))
    result = lang.plugin(blob["lang"]).bundler(lexicon, data)(blob)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=args.indent)
    sys.stdout.write("\n")
