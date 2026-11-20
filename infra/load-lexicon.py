#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["wordfreq==3.1.1"]
# ///
"""Loads a language's lexicon into its D1 database (LEXICON_{LANG} in lexicon/wrangler.jsonc):
  load-lexicon.py <staging|production|pr-N|local> <sqlite>
      [--sample N] [--persist-to DIR] [--built-from OUT]
  load-lexicon.py <staging|production|pr-N|local> --lang LANG --built-from OUT
      [--sample N] [--persist-to DIR]
sqlite is analysis's {lang}.d1.sqlite (skolia-build-d1-export, or the Nix output
analysis#d1-export-{lang}), which has D1's schema; its meta table gives the language and
version. Skipped if D1
already serves that version. The new version's rows go in beside the old ones, then
loaded points at it and the old rows are deleted in batches (lexicon/migrations), so a
load that stops part way leaves the old version serving and can be run again. local is wrangler
dev's database (api/.wrangler/state, just dev-api), or with --persist-to, the one in DIR
(api/scripts/e2e.sh).
For previews, --sample loads entries for wordfreq's N most common words and adds +sampleN
to their version. --built-from OUT, the Nix output sqlite is in, is
recorded in loaded once the old rows are deleted; without sqlite, it prints current if D1 last
loaded OUT, else stale (just load-lexicon, to skip the build). Needs the credentials
infra/wrangler.sh needs.
"""

import argparse
import json
import re
import sqlite3
import subprocess
import tempfile
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import wordfreq

INFRA = Path(__file__).resolve().parent
WRANGLER = INFRA / "wrangler.sh"
LEXICON = INFRA.parent / "lexicon"
# Where just dev-api's wrangler dev keeps its local state, every Worker's
DEV_STATE = INFRA.parent / "api" / ".wrangler" / "state"
# D1's longest statement is 100 KB; the longest row is 35 KB (English)
MAX_STATEMENT_BYTES = 90_000
# Old rows deleted per statement, so no one statement deletes a whole language
CLEAN_BATCH = 50_000


@dataclass(frozen=True)
class Target:
    """A language's lexicon database in an environment. persist_to: wrangler dev's state
    directory, for local."""

    env: str
    lang: str
    persist_to: Path | None = None


def config(env: str) -> Path:
    """The lexicon Worker's wrangler config for env. A preview's is made from staging's
    (infra/preview.py) if this checkout hasn't one."""
    if not env.startswith("pr-"):
        return LEXICON / "wrangler.jsonc"
    path = LEXICON / f"wrangler.{env}.json"
    if not path.exists():
        subprocess.run(
            [str(INFRA / "preview.py"), "config", env], check=True, stdout=subprocess.DEVNULL
        )
    return path


def wrangler(target: Target, *args: str) -> str:
    where = ["--remote"]
    if target.env == "local":
        persist_to = DEV_STATE if target.persist_to is None else target.persist_to
        where = ["--local", "--persist-to", str(persist_to.resolve())]
    command = [
        str(WRANGLER),
        "production" if target.env == "local" else target.env,
        "d1",
        "execute",
        f"LEXICON_{target.lang.upper()}",
        "-c",
        str(config(target.env)),
        *where,
        *args,
    ]
    return subprocess.run(command, stdout=subprocess.PIPE, text=True, check=True).stdout


def quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def meta(db: sqlite3.Connection) -> tuple[str, str]:
    rows = dict(cast(list[tuple[str, str]], db.execute("SELECT key, value FROM meta").fetchall()))
    lang, version = rows.get("lang"), rows.get("version")
    if lang is None or version is None:
        raise SystemExit("the lexicon's meta table has no lang or version")
    if not re.fullmatch(r"[a-z]+", lang):
        raise SystemExit(f"the lexicon's lang isn't a language code: {lang}")
    return lang, version


@dataclass(frozen=True)
class Loaded:
    version: str
    built_from: str | None


def serving(target: Target) -> Loaded | None:
    out = wrangler(target, "--json", "--command", "SELECT version, built_from FROM loaded")
    results = cast(list[dict[str, list[dict[str, str | None]]]], json.loads(out))
    rows = results[0]["results"] if results else []
    if not rows:
        return None
    version = rows[0]["version"]
    assert version is not None
    return Loaded(version, rows[0]["built_from"])


def built_from_key(built_from: str, sample: int | None) -> str:
    return built_from if sample is None else f"{built_from}+sample{sample}"


def record_built_from(target: Target, version: str, key: str) -> None:
    wrangler(
        target,
        "--command",
        f"UPDATE loaded SET built_from = {quote(key)} WHERE version = {quote(version)}",
    )


TABLES = ("entry", "relation", "featureset")
"""The tables the export fills, copied column for column, since it has D1's schema."""

type Cell = str | int | None


def sampled(db: sqlite3.Connection, lang: str, sample: int) -> frozenset[str]:
    """The nodes a preview loads: every entry of wordfreq's sample most common words (run
    the noun and the verb), not proper nouns, and the nodes their relations point at."""
    words = frozenset(wordfreq.top_n_list(lang, sample))
    sources = frozenset(
        lemma_id
        for lemma_id, lemma, upos in cast(
            Iterable[tuple[str, str, str | None]],
            db.execute("SELECT lemma_id, lemma, upos FROM entry WHERE upos IS NOT NULL"),
        )
        if upos != "PROPN" and lemma.lower() in words
    )
    targets = frozenset(
        target_id
        for source_id, target_id in cast(
            Iterable[tuple[str, str]], db.execute("SELECT source_id, target_id FROM relation")
        )
        if source_id in sources
    )
    return sources | targets


def statements(db: sqlite3.Connection, lang: str, version: str, sample: int | None) -> list[str]:
    which = f"version = {quote(version)}"
    out = [f"DELETE FROM {table} WHERE {which};" for table in TABLES]
    keep = None if sample is None else sampled(db, lang, sample)
    for table in TABLES:
        columns = [cast(str, column[1]) for column in db.execute(f"PRAGMA table_info({table})")]
        rows = cast(
            Iterable[tuple[Cell, ...]], db.execute(f"SELECT {', '.join(columns)} FROM {table}")
        )
        if keep is not None and table == "entry":
            lemma_id = columns.index("lemma_id")
            rows = (row for row in rows if row[lemma_id] in keep)
        if keep is not None and table == "relation":
            source, target = columns.index("source_id"), columns.index("target_id")
            rows = (row for row in rows if row[source] in keep and row[target] in keep)
        at = columns.index("version")
        out += inserts(
            f"INSERT INTO {table} ({', '.join(columns)}) VALUES",
            ((*row[:at], version, *row[at + 1 :]) for row in rows),
        )
    out.append(
        f"INSERT INTO loaded (id, version, built_from) VALUES (1, {quote(version)}, NULL) "
        "ON CONFLICT (id) DO UPDATE SET version = excluded.version, built_from = NULL;"
    )
    return out


def literal(cell: Cell) -> str:
    match cell:
        case None:
            return "NULL"
        case int():
            return str(cell)
        case str():
            return quote(cell)


def inserts(head: str, rows: Iterable[Sequence[Cell]]) -> list[str]:
    """Multi-row INSERTs, each under D1's longest statement."""
    out: list[str] = []
    values: list[str] = []
    size = len(head) + 1
    for row in rows:
        value = f"({', '.join(literal(cell) for cell in row)})"
        if values and size + len(value.encode()) + 2 > MAX_STATEMENT_BYTES:
            out.append(head + "\n" + ",\n".join(values) + ";")
            values, size = [], len(head) + 1
        values.append(value)
        size += len(value.encode()) + 2
    if values:
        out.append(head + "\n" + ",\n".join(values) + ";")
    return out


def clean(target: Target, version: str) -> None:
    """Deletes the rows of other versions, in batches. Run on every load, so a load that
    stopped after repointing loaded is cleaned up by the next."""
    replaced = ", ".join(old_versions(target, version)) or "older versions"
    for table, key in (("entry", "lemma_id, version"), ("relation", "source_id, version, ord")):
        old = f"FROM {table} WHERE version != {quote(version)}"
        batch = f"SELECT {key} {old} LIMIT {CLEAN_BATCH}"
        delete = f"DELETE FROM {table} WHERE ({key}) IN ({batch})"
        # wrangler's local output doesn't count a delete's changes, so ask what's left
        count = f"SELECT count(*) AS n {old}"
        while (left := remaining(target, count)) > 0:
            print(f"{target.env}: deleting {target.lang} {table} {replaced}, {left} rows left")
            wrangler(target, "--command", delete)
    # A few thousand rows per version; last, so old_versions finds a stopped clean's versions
    wrangler(target, "--command", f"DELETE FROM featureset WHERE version != {quote(version)}")


def old_versions(target: Target, version: str) -> list[str]:
    """The versions besides version that still have rows, by their featuresets, which go last."""
    out = wrangler(
        target,
        "--json",
        "--command",
        f"SELECT DISTINCT version FROM featureset WHERE version != {quote(version)}",
    )
    results = cast(list[dict[str, list[dict[str, str]]]], json.loads(out))
    return [row["version"] for row in results[0]["results"]]


def remaining(target: Target, count: str) -> int:
    results = cast(
        list[dict[str, list[dict[str, int]]]],
        json.loads(wrangler(target, "--json", "--command", count)),
    )
    return results[0]["results"][0]["n"]


def main() -> None:
    parser = argparse.ArgumentParser(description="Loads a language's lexicon into its D1 database.")
    parser.add_argument("env", help="staging, production, pr-N or local")
    parser.add_argument("sqlite", type=Path, nargs="?", help="analysis's {lang}.d1.sqlite")
    parser.add_argument("--sample", type=int, help="only wordfreq's N most common words")
    parser.add_argument("--persist-to", type=Path, help="wrangler dev's state directory (local)")
    parser.add_argument(
        "--built-from",
        help="the Nix output containing the SQLite file. With no file, reports current or stale.",
    )
    parser.add_argument("--lang", help="the language, when there's no sqlite")
    args = parser.parse_args()
    env = cast(str, args.env)
    path = cast(Path | None, args.sqlite)
    sample = cast(int | None, args.sample)
    persist_to = cast(Path | None, args.persist_to)
    built_from = cast(str | None, args.built_from)
    if not re.fullmatch(r"staging|production|pr-[0-9]+|local", env):
        parser.error("env must be staging, production, pr-N or local")
    if persist_to is not None and env != "local":
        parser.error("--persist-to is for local")
    key = None if built_from is None else built_from_key(built_from, sample)
    if path is None:
        lang = cast(str | None, args.lang)
        if key is None or lang is None or not re.fullmatch(r"[a-z]+", lang):
            parser.error("without sqlite, give --built-from and --lang")
        loaded = serving(Target(env, lang, persist_to))
        print("current" if loaded is not None and loaded.built_from == key else "stale")
        return
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    lang, version = meta(db)
    target = Target(env, lang, persist_to)
    if sample is not None:
        version = f"{version}+sample{sample}"
    loaded = serving(target)
    if loaded is not None and loaded.version == version:
        print(f"{env}: {lang} already serves {version}")
    else:
        with tempfile.TemporaryDirectory() as scratch:
            sql = Path(scratch) / f"lexicon-{lang}.sql"
            sql.write_text("\n".join(statements(db, lang, version, sample)) + "\n")
            print(f"{env}: loading {lang} {version} ({sql.stat().st_size / 1e6:.0f} MB of SQL)")
            wrangler(target, "--yes", "--file", str(sql))
        loaded = serving(target)
        if loaded is None or loaded.version != version:
            raise SystemExit(f"{env}: {lang} doesn't serve {version} after loading it")
        print(f"{env}: {lang} serves {version}")
    clean(target, version)
    if key is not None:
        record_built_from(target, version, key)


if __name__ == "__main__":
    main()
