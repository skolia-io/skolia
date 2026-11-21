#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Deletes the lexicon databases no lexicon Worker binds: gc-lexicon.py [--delete]; without
--delete it lists them. A database is kept if a lexicon Worker (skolia-lexicon[-env]) binds
it in its active deployment or in one of its KEEP_VERSIONS newest versions, so a rollback
finds it, or if it's younger than MIN_AGE, so one loaded for a deploy still running is.
Runs nightly (.github/workflows/sweep.yml). Needs CLOUDFLARE_ACCOUNT_ID and
CLOUDFLARE_API_TOKEN.
"""

import argparse
import logging
import re
import sys
from datetime import UTC, datetime, timedelta
from typing import cast

import cloudflare
from cloudflare import Database, JsonObject

KEEP_VERSIONS = 5
MIN_AGE = timedelta(days=2)
# skolia-lexicon-pl[-env]-{hash}, and before databases were per build, skolia-lexicon-pl[-env]
DATABASE = re.compile(r"skolia-lexicon-[a-z]+(-staging|-pr-[0-9]+)?(-[0-9a-f]{12})?")
WORKER = re.compile(r"skolia-lexicon(-staging|-pr-[0-9]+)?")

log = logging.getLogger("gc-lexicon")


def versions(script: str) -> set[str]:
    """The versions of script that may serve again: its active deployment's and its newest."""
    deployments = cast(
        JsonObject, cloudflare.result("GET", f"workers/scripts/{script}/deployments")
    )
    # The latest deployment is the active one (wrangler's fetchLatestDeployment)
    active = {
        cast(str, version["version_id"])
        for deployment in cast(list[JsonObject], deployments["deployments"])[:1]
        for version in cast(list[JsonObject], deployment["versions"])
    }
    listed = sorted(
        cloudflare.pages(f"workers/scripts/{script}/versions", "items"),
        key=lambda version: cast(str, cast(JsonObject, version["metadata"])["created_on"]),
        reverse=True,
    )
    return active | {cast(str, version["id"]) for version in listed[:KEEP_VERSIONS]}


def bound(script: str, version: str) -> set[str]:
    """The D1 databases a version of script binds, by id."""
    detail = cast(
        JsonObject, cloudflare.result("GET", f"workers/scripts/{script}/versions/{version}")
    )
    bindings = cast(list[JsonObject], cast(JsonObject, detail["resources"])["bindings"])
    return {cast(str, binding["id"]) for binding in bindings if binding["type"] == "d1"}


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stderr)
    parser = argparse.ArgumentParser(description="Deletes the lexicon databases nothing binds.")
    parser.add_argument("--delete", action="store_true", help="delete them, not just list them")
    delete = cast(bool, parser.parse_args().delete)
    scripts = [
        cast(str, script["id"])
        for script in cast(list[JsonObject], cloudflare.result("GET", "workers/scripts"))
        if WORKER.fullmatch(cast(str, script["id"]))
    ]
    kept = {
        db for script in scripts for version in versions(script) for db in bound(script, version)
    }
    now = datetime.now(UTC)
    unbound: list[Database] = [
        db
        for db in cloudflare.databases()
        if DATABASE.fullmatch(db.name)
        and db.uuid not in kept
        and now - datetime.fromisoformat(db.created_at) > MIN_AGE
    ]
    log.info(
        "%d lexicon Workers bind %d databases; %d unbound", len(scripts), len(kept), len(unbound)
    )
    for db in sorted(unbound, key=lambda db: db.name):
        action = "deleting" if delete else "unbound:"
        log.info("%s %s (%s, made %s)", action, db.name, db.uuid, db.created_at)
        if delete:
            cloudflare.result("DELETE", f"d1/database/{db.uuid}")


if __name__ == "__main__":
    main()
