"""The Cloudflare API under accounts/{CLOUDFLARE_ACCOUNT_ID}/, with CLOUDFLARE_API_TOKEN, for
infra's scripts (load-lexicon.py, gc-lexicon.py)."""

import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import cast

type Json = str | int | float | bool | list[Json] | dict[str, Json] | None
type JsonObject = dict[str, Json]

API = "https://api.cloudflare.com/client/v4"
PER_PAGE = 100
LIST_ATTEMPTS = 5
# Seconds before the nth listing again, times n
LIST_BACKOFF_SECONDS = 2

log = logging.getLogger("cloudflare")


class NotFound(Exception):
    pass


def variable(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} isn't set")
    return value


def call(
    method: str, path: str, body: Json = None, params: Mapping[str, str | int] | None = None
) -> JsonObject:
    """The whole response. Raises NotFound on a 404, SystemExit on any other failure."""
    query = "" if params is None else "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f"{API}/accounts/{variable('CLOUDFLARE_ACCOUNT_ID')}/{path}{query}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {variable('CLOUDFLARE_API_TOKEN')}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request) as response:
            return cast(JsonObject, json.load(response))
    except urllib.error.HTTPError as error:
        if error.code == 404:
            raise NotFound(f"{method} {path}") from error
        raise SystemExit(f"{method} {path}: {error.code} {error.read().decode()}") from error


def result(method: str, path: str, body: Json = None) -> Json:
    return call(method, path, body)["result"]


def listing(path: str, field: str | None) -> tuple[list[JsonObject], int | None]:
    """Every page's items, and the total the last page gave."""
    page, items = 1, list[JsonObject]()
    while True:
        response = call("GET", path, params={"page": page, "per_page": PER_PAGE})
        listed = (
            response["result"] if field is None else cast(JsonObject, response["result"])[field]
        )
        got = cast(list[JsonObject], listed)
        items += got
        info = cast(JsonObject, response.get("result_info") or {})
        total = info.get("total_count")
        if len(got) < PER_PAGE or (isinstance(total, int) and len(items) >= total):
            return items, total if isinstance(total, int) else None
        page += 1


def pages(path: str, field: str | None = None) -> list[JsonObject]:
    """Every item of a paged list, checked against its total: the result (D1 databases), or
    the result's field (a Worker's versions, items). While databases are made or deleted (a
    preview's teardown during a deploy), D1's list can count some it leaves out, so a listing
    whose count and total disagree is taken again, LIST_ATTEMPTS times in all."""
    items, total = listing(path, field)
    attempt = 1
    while total is not None and len(items) != total:
        if attempt == LIST_ATTEMPTS:
            raise SystemExit(f"GET {path}: listed {len(items)} of {total} {attempt} times")
        log.warning("GET %s: listed %d of %d, listing again", path, len(items), total)
        time.sleep(LIST_BACKOFF_SECONDS * attempt)
        items, total = listing(path, field)
        attempt += 1
    return items


@dataclass(frozen=True)
class Database:
    """replicated: read replication's mode is auto."""

    uuid: str
    name: str
    created_at: str
    replicated: bool


def as_database(found: JsonObject) -> Database:
    replication = cast(JsonObject, found.get("read_replication") or {})
    return Database(
        cast(str, found["uuid"]),
        cast(str, found["name"]),
        cast(str, found["created_at"]),
        replication.get("mode") == "auto",
    )


def database(name: str) -> Database | None:
    """The D1 database named name, or None."""
    try:
        return as_database(
            cast(JsonObject, result("GET", f"d1/database/{urllib.parse.quote(name)}"))
        )
    except NotFound:
        return None


def databases() -> list[Database]:
    return [as_database(db) for db in pages("d1/database")]


def replicate(db: Database) -> None:
    result("PUT", f"d1/database/{db.uuid}", {"read_replication": {"mode": "auto"}})


def query(db: Database, sql: str) -> list[JsonObject]:
    """The rows of one statement."""
    results = cast(list[JsonObject], result("POST", f"d1/database/{db.uuid}/query", {"sql": sql}))
    return cast(list[JsonObject], results[0]["results"])
