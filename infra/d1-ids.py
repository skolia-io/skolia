#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["json5==0.17.3"]
# ///
"""A deploy's wrangler config with each D1 binding's database_id, found by its database_name:
  d1-ids.py staging api/wrangler.jsonc api/wrangler.deploy.json
The bindings are env.staging's for staging, the top level's for production and pr-<N>.
Without an id, wrangler deploy reuses the deployed Worker's binding, and fails once
Terraform has replaced that database. Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.
"""

import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import cast

import json5

type Json = str | int | float | bool | None | list[Json] | dict[str, Json]
type JsonObject = dict[str, Json]


def as_object(value: Json, what: str) -> JsonObject:
    if not isinstance(value, dict):
        raise SystemExit(f"{what}: not an object")
    return value


def as_list(value: Json, what: str) -> list[Json]:
    if not isinstance(value, list):
        raise SystemExit(f"{what}: not a list")
    return value


def as_string(value: Json, what: str) -> str:
    if not isinstance(value, str):
        raise SystemExit(f"{what}: not a string")
    return value


def variable(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} isn't set")
    return value


def database_id(name: str) -> str:
    query = urllib.parse.urlencode({"name": name, "per_page": 100})
    request = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{variable('CLOUDFLARE_ACCOUNT_ID')}/d1/database?{query}",
        headers={"Authorization": f"Bearer {variable('CLOUDFLARE_API_TOKEN')}"},
    )
    with urllib.request.urlopen(request) as response:
        body = as_object(cast(Json, json.load(response)), f"D1 databases named {name}")
    ids = [
        as_string(db.get("uuid"), f"{name} uuid")
        for db in (as_object(d, f"D1 database {name}") for d in as_list(body.get("result"), f"D1 databases named {name}"))
        if db.get("name") == name
    ]
    if len(ids) != 1:
        raise SystemExit(f"{len(ids)} D1 databases named {name}")
    return ids[0]


def main() -> None:
    if len(sys.argv) != 4 or not re.fullmatch(r"staging|production|pr-[0-9]+", sys.argv[1]):
        raise SystemExit("usage: d1-ids.py <staging|production|pr-N> <config> <out>")
    env, source, out = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    config = as_object(cast(Json, json5.loads(source.read_text())), str(source))
    block = as_object(as_object(config.get("env"), f"{source} env").get("staging"), f"{source} env.staging") if env == "staging" else config
    for binding in as_list(block.get("d1_databases", []), f"{source} d1_databases"):
        db = as_object(binding, f"{source} d1_databases entry")
        db["database_id"] = database_id(as_string(db.get("database_name"), f"{source} database_name"))
    out.write_text(f"{json.dumps(config, indent=2)}\n")


if __name__ == "__main__":
    main()
