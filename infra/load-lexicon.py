#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["wordfreq==3.1.1"]
# ///
"""Loads each language's lexicon into a D1 database of its own, and writes the lexicon
Worker's wrangler config that binds them:
  load-lexicon.py state <env> --lang LANG --built-from OUT [--sample N] [--persist-to DIR]
  load-lexicon.py load <env> <sqlite> --built-from OUT [--sample N] [--persist-to DIR]
  load-lexicon.py config <env> [--sample N] [--check]
env is staging, production, pr-N or local. sqlite is analysis's {lang}.d1.sqlite
(skolia-build-d1-export, or the Nix output analysis#d1-export-{lang}), which has D1's schema;
its meta table gives the language. OUT is the Nix output sqlite is in; with --sample (the
previews' wordfreq N most common words), OUT+sampleN.

A deployed environment's database for a build is skolia-lexicon-{lang}[-env]-{hash of OUT},
made, loaded and never written again; its loaded row goes in last, so a database without one
is a load that stopped, and is made again. state prints current if the database is loaded,
else stale (just load-lexicon, to skip the build). config binds the databases this
checkout's builds name (nix eval), and fails if one isn't loaded, then writes
lexicon/wrangler.{env}.jsonc from lexicon/wrangler.template.jsonc. infra/gc-lexicon.py
deletes the databases no Worker binds.

local is wrangler dev's database (api/.wrangler/state, just dev-api), or with --persist-to,
the one in DIR (e2e/e2e.sh): one per language, emptied and loaded again. Its config,
lexicon/wrangler.jsonc, is committed; config local --check fails if it's out of date.
Needs the credentials infra/wrangler.sh needs.
"""

import argparse
import hashlib
import json
import re
import sqlite3
import subprocess
import tempfile
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import cloudflare
import wordfreq
from cloudflare import Database, Json, JsonObject

INFRA = Path(__file__).resolve().parent
ROOT = INFRA.parent
WRANGLER = INFRA / "wrangler.sh"
LEXICON = ROOT / "lexicon"
TEMPLATE = LEXICON / "wrangler.template.jsonc"
# Where just dev-api's wrangler dev keeps its local state, every Worker's
DEV_STATE = ROOT / "api" / ".wrangler" / "state"
LANGS = ("en", "fr", "pl")
# infra/variables.tf's location
LOCATION = "oc"
# D1's longest statement is 100 KB; the longest row is 35 KB (English)
MAX_STATEMENT_BYTES = 90_000
# 64 bits of SHA-256
VERSION_HEX = 16
# 48 bits of SHA-256 of what a database is loaded from
NAME_HEX = 12
# A string that's all placeholder, so the template is JSONC too
PLACEHOLDER = re.compile(r"\"\$\{([A-Za-z_][A-Za-z0-9_]*)\}\"")

TABLES = {
    "entry": ("lemma_id",),
    "relation": ("source_id", "ord"),
    "featureset": ("id", "feature"),
    "form_pronunciation": ("form", "upos"),
}
"""The tables the export fills, copied column for column, since it has D1's schema, with
each one's primary key but version."""

type Cell = str | int | None


@dataclass(frozen=True)
class Local:
    """A language's database in wrangler dev's state directory."""

    lang: str
    persist_to: Path


def binding(lang: str) -> str:
    return f"LEXICON_{lang.upper()}"


def suffix(env: str) -> str:
    return "" if env == "production" else f"-{env}"


def built_from_key(built_from: str, sample: int | None) -> str:
    return built_from if sample is None else f"{built_from}+sample{sample}"


def database_name(lang: str, env: str, key: str) -> str:
    """The database env loads key into: named for it, so the load and the deploy that binds
    it agree without passing anything between them."""
    digest = hashlib.sha256(key.encode()).hexdigest()[:NAME_HEX]
    return f"skolia-lexicon-{lang}{suffix(env)}-{digest}"


def quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def local_wrangler(target: Local, *args: str) -> str:
    command = [
        str(ROOT / "api" / "node_modules" / ".bin" / "wrangler"),
        "d1",
        "execute",
        binding(target.lang),
        "-c",
        str(LEXICON / "wrangler.jsonc"),
        "--local",
        "--persist-to",
        str(target.persist_to.resolve()),
        *args,
    ]
    return subprocess.run(command, stdout=subprocess.PIPE, text=True, check=True).stdout


def local_built_from(target: Local) -> str | None:
    out = local_wrangler(target, "--json", "--command", "SELECT built_from FROM loaded")
    results = cast(list[dict[str, list[dict[str, str | None]]]], json.loads(out))
    rows = results[0]["results"] if results else []
    return rows[0]["built_from"] if rows else None


def loaded(db: Database, key: str) -> bool:
    """Whether db has its loaded row, the last a load writes, for key."""
    tables = cloudflare.query(db, "SELECT name FROM sqlite_master WHERE name = 'loaded'")
    if not tables:
        return False
    rows = cloudflare.query(db, "SELECT built_from FROM loaded")
    return bool(rows) and rows[0]["built_from"] == key


def meta(db: sqlite3.Connection) -> tuple[str, str]:
    rows = dict(cast(list[tuple[str, str]], db.execute("SELECT key, value FROM meta").fetchall()))
    lang, version = rows.get("lang"), rows.get("version")
    if lang is None or version is None:
        raise SystemExit("the lexicon's meta table has no lang or version")
    if lang not in LANGS:
        raise SystemExit(f"the lexicon's lang isn't one of {', '.join(LANGS)}: {lang}")
    return lang, version


def sampled(db: sqlite3.Connection, words: frozenset[str]) -> frozenset[str]:
    """The entries a preview loads: every entry of wordfreq's sample most common words (run
    the noun and the verb), not proper nouns. Each is whole, its senses already resolved,
    so what its relations point at needn't come along."""
    return frozenset(
        lemma_id
        for lemma_id, lemma, upos in cast(
            Iterable[tuple[str, str, str]], db.execute("SELECT lemma_id, lemma, upos FROM entry")
        )
        if upos != "PROPN" and lemma.lower() in words
    )


def exported(
    db: sqlite3.Connection, lang: str, sample: int | None
) -> Iterator[tuple[str, list[str], Iterator[tuple[Cell, ...]]]]:
    """Each table's columns but version, and the rows a load copies, in key order."""
    words = None if sample is None else frozenset(wordfreq.top_n_list(lang, sample))
    keep = None if words is None else sampled(db, words)
    for table, key in TABLES.items():
        columns = [
            name
            for name in (
                cast(str, column[1]) for column in db.execute(f"PRAGMA table_info({table})")
            )
            if name != "version"
        ]
        rows = cast(
            Iterator[tuple[Cell, ...]],
            db.execute(f"SELECT {', '.join(columns)} FROM {table} ORDER BY {', '.join(key)}"),
        )
        if keep is not None and table == "entry":
            lemma_id = columns.index("lemma_id")
            rows = (row for row in rows if row[lemma_id] in keep)
        if keep is not None and table == "relation":
            source = columns.index("source_id")
            rows = (row for row in rows if row[source] in keep)
        if words is not None and table == "form_pronunciation":
            form = columns.index("form")
            rows = (row for row in rows if str(row[form]).lower() in words)
        yield table, columns, rows


def content_version(db: sqlite3.Connection, lang: str, sample: int | None) -> str:
    """The version the database serves: a hash of the rows a load copies, so it changes
    exactly when they do, and a lookup pinned to it can be cached for good."""
    digest = hashlib.sha256()
    for table, columns, rows in exported(db, lang, sample):
        digest.update(json.dumps([table, columns]).encode() + b"\n")
        for row in rows:
            digest.update(json.dumps(row, ensure_ascii=False).encode() + b"\n")
    return digest.hexdigest()[:VERSION_HEX]


def schema(db: sqlite3.Connection) -> list[str]:
    """The export's tables and indexes, as lexicon/migrations made them, without its meta or
    SQLite's own (sqlite_stat1), which D1 won't make."""
    rows = cast(
        list[tuple[str]],
        db.execute(
            "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name != 'meta'"
            " AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid"
        ).fetchall(),
    )
    return [f"{sql};" for (sql,) in rows]


def statements(
    db: sqlite3.Connection, lang: str, version: str, key: str, sample: int | None
) -> list[str]:
    out: list[str] = []
    for table, columns, rows in exported(db, lang, sample):
        out += inserts(
            f"INSERT INTO {table} (version, {', '.join(columns)}) VALUES",
            ((version, *row) for row in rows),
        )
    out.append(
        f"INSERT INTO loaded (id, version, built_from) VALUES (1, {quote(version)}, {quote(key)});"
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


def write_sql(sql: list[str], scratch: str, lang: str) -> Path:
    path = Path(scratch) / f"lexicon-{lang}.sql"
    path.write_text("\n".join(sql) + "\n")
    return path


def load_remote(env: str, db: sqlite3.Connection, key: str, sample: int | None) -> None:
    lang, built = meta(db)
    name = database_name(lang, env, key)
    existing = cloudflare.database(name)
    if existing is not None and loaded(existing, key):
        if not existing.replicated:
            cloudflare.replicate(existing)
        print(f"{env}: {name} is already loaded")
        return
    if existing is not None:
        print(f"{env}: deleting {name}, which a load left part way")
        cloudflare.result("DELETE", f"d1/database/{existing.uuid}")
    made = cast(
        JsonObject,
        cloudflare.result("POST", "d1/database", {"name": name, "primary_location_hint": LOCATION}),
    )
    target = cloudflare.as_database(made)
    version = content_version(db, lang, sample)
    with tempfile.TemporaryDirectory() as scratch:
        sql = write_sql(schema(db) + statements(db, lang, version, key, sample), scratch, lang)
        size = f"{sql.stat().st_size / 1e6:.0f} MB of SQL"
        print(f"{env}: loading {name}, {lang} {version}, built {built} ({size})")
        command = [str(WRANGLER), "account", "d1", "execute", name, "--remote", "--yes"]
        subprocess.run([*command, "--file", str(sql)], stdout=subprocess.DEVNULL, check=True)
    if not loaded(target, key):
        raise SystemExit(f"{env}: {name} has no loaded row after loading it")
    # Once it's loaded, so the load's writes go to the primary alone. state counts it, so a
    # load that stopped before it runs again.
    cloudflare.replicate(target)
    print(f"{env}: {name} serves {lang} {version}")


def load_local(target: Local, db: sqlite3.Connection, key: str, sample: int | None) -> None:
    lang, built = meta(db)
    version = content_version(db, lang, sample)
    empty = [f"DELETE FROM {table};" for table in (*TABLES, "loaded")]
    with tempfile.TemporaryDirectory() as scratch:
        sql = write_sql(empty + statements(db, lang, version, key, sample), scratch, lang)
        print(f"local: loading {lang} {version}, built {built}")
        local_wrangler(target, "--yes", "--file", str(sql))
    if local_built_from(target) != key:
        raise SystemExit(f"local: {lang} has no loaded row for {key} after loading it")


def worker(env: str) -> tuple[str, list[Json]]:
    """The Worker's name and routes in env."""
    match env:
        case "production":
            return "skolia-lexicon", [{"pattern": "lexicon.skolia.io", "custom_domain": True}]
        case "staging":
            return "skolia-lexicon-staging", [
                {"pattern": "lexicon-staging.skolia.io", "custom_domain": True}
            ]
        case "local":
            return "skolia-lexicon", []
        case _:
            return f"skolia-lexicon-{env}", []


def environments(env: str, name: str, routes: list[Json], names: Mapping[str, str]) -> Json:
    """The config's env blocks: staging's or production's, deployed with --env so its traces
    are tagged deployment.environment.name, holds what the top level does, since routes and
    bindings aren't inherited. Local and previews have none."""
    match env:
        case "staging" | "production":
            databases: list[Json] = [
                {
                    "binding": binding(lang),
                    "database_name": names[lang],
                    "migrations_dir": "migrations",
                }
                for lang in LANGS
            ]
            return {env: {"name": name, "routes": routes, "d1_databases": databases}}
        case _:
            return {}


def render(template: str, values: Mapping[str, Json]) -> str:
    """template with each "${name}" replaced by values[name] as JSON. Every placeholder needs a
    value and every value a placeholder."""
    names = set(cast(list[str], PLACEHOLDER.findall(template)))
    if missing := names - values.keys():
        raise SystemExit(f"{TEMPLATE.name}: no value for {', '.join(sorted(missing))}")
    if unused := values.keys() - names:
        raise SystemExit(f"{TEMPLATE.name}: nothing to replace for {', '.join(sorted(unused))}")
    return PLACEHOLDER.sub(lambda match: json.dumps(values[match[1]]), template)


def nix_out(lang: str) -> str:
    return subprocess.run(
        ["nix", "eval", "--raw", f"./analysis#d1-export-{lang}.outPath"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        text=True,
        check=True,
    ).stdout


def bound(env: str, sample: int | None) -> dict[str, str]:
    """Each language's database in env: this checkout's build's, which must be loaded."""
    if env == "local":
        return {lang: f"skolia-lexicon-{lang}-local" for lang in LANGS}
    names: dict[str, str] = {}
    for lang in LANGS:
        key = built_from_key(nix_out(lang), sample)
        name = database_name(lang, env, key)
        db = cloudflare.database(name)
        if db is None or not loaded(db, key):
            raise SystemExit(f"{env}: {name} isn't loaded; just load-lexicon {env} first")
        names[lang] = name
    return names


def config(env: str, sample: int | None, check: bool) -> None:
    names = bound(env, sample)
    name, routes = worker(env)
    text = render(
        TEMPLATE.read_text(),
        {
            "name": name,
            "routes": routes,
            "env": environments(env, name, routes, names),
            **{binding(lang): names[lang] for lang in LANGS},
        },
    )
    made = f"// Made by infra/load-lexicon.py config {env} from wrangler.template.jsonc\n" + text
    path = LEXICON / ("wrangler.jsonc" if env == "local" else f"wrangler.{env}.jsonc")
    if check:
        if not path.exists() or path.read_text() != made:
            raise SystemExit(f"{path.name} is out of date: infra/load-lexicon.py config {env}")
        return
    path.write_text(made)
    print(path.relative_to(ROOT))


def main() -> None:
    parser = argparse.ArgumentParser(description="Loads each language's lexicon into D1.")
    commands = parser.add_subparsers(dest="command", required=True)
    state = commands.add_parser("state", help="current if the build is loaded, else stale")
    load = commands.add_parser("load", help="load a build")
    configure = commands.add_parser("config", help="write the Worker's wrangler config")
    for command in (state, load, configure):
        command.add_argument("env", help="staging, production, pr-N or local")
        command.add_argument("--sample", type=int, help="only wordfreq's N most common words")
    for command in (state, load):
        command.add_argument("--built-from", required=True, help="the Nix output of the build")
        command.add_argument("--persist-to", type=Path, help="wrangler dev's state (local)")
    state.add_argument("--lang", required=True, choices=LANGS)
    load.add_argument("sqlite", type=Path, help="analysis's {lang}.d1.sqlite")
    configure.add_argument("--check", action="store_true", help="fail if it's out of date")
    args = parser.parse_args()
    command = cast(str, args.command)
    env = cast(str, args.env)
    sample = cast(int | None, args.sample)
    if not re.fullmatch(r"staging|production|pr-[0-9]+|local", env):
        parser.error("env must be staging, production, pr-N or local")
    if command == "config":
        config(env, sample, cast(bool, args.check))
        return
    key = built_from_key(cast(str, args.built_from), sample)
    persist_to = cast(Path | None, args.persist_to)
    if persist_to is not None and env != "local":
        parser.error("--persist-to is for local")
    if command == "state":
        lang = cast(str, args.lang)
        if env == "local":
            current = local_built_from(Local(lang, persist_to or DEV_STATE)) == key
        else:
            db = cloudflare.database(database_name(lang, env, key))
            current = db is not None and db.replicated and loaded(db, key)
        print("current" if current else "stale")
        return
    db = sqlite3.connect(f"file:{cast(Path, args.sqlite)}?mode=ro", uri=True)
    if env == "local":
        load_local(Local(meta(db)[0], persist_to or DEV_STATE), db, key, sample)
    else:
        load_remote(env, db, key, sample)


if __name__ == "__main__":
    main()
