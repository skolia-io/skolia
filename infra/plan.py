#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""What a CI run and a deploy of an environment need to do: each node of GRAPH whose key
skolia-ci (infra/shared/ci.tf) has no record of.
  plan.py checks                        print the checks still to pass, as JSON, for ci.yml:
                                        {"check": true, "screenshots": false, "plan_infra": ["shared"]}
  plan.py passed <check>                record a check's pass
  plan.py <staging|production|pr-N>     print the deploy's plan as JSON, for deploy.yml:
                                        {"images": ["pl"], "worker": true, "infra": false, ...}
  plan.py built <build>                 record a build's key once it's in the registry or Cachix
  plan.py deployed <env> <deploy>       record a deploy's key once it's deployed
  plan.py torn-down <env>               record that a preview serves nothing (infra/teardown.sh)
  plan.py keys                          print each node's key
  plan.py version                       the skolia Worker's version
A node's key is a hash of its content, a Nix out path that nix eval gives without building
anything, and the keys of what it depends on: its build edges (what it's made from) and its
test edges (what it runs against). So a change reaches everything downstream of it, and
nothing else. A build or check is recorded once for every environment (the build table), a
deploy for each environment (deployment). Without CLOUDFLARE_API_TOKEN (a fork's pull
request) every check runs and none is recorded. The version is the tag at HEAD, or else the
last tag and the skolia Worker's out path hash (v0.0.17+4qqk2ki3mxwb): not a commit, so a
skipped deploy serves what a new one would. Secrets aren't in any key: after changing one,
deploy by hand. Needs the tags (a full clone), CLOUDFLARE_ACCOUNT_ID and
CLOUDFLARE_API_TOKEN.
"""

import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import cache
from pathlib import Path
from typing import Literal, cast

ROOT = Path(__file__).resolve().parent.parent
LANGS = ("pl", "en", "fr")
DATABASE = "skolia-ci"
ENV = re.compile(r"staging|production|pr-[0-9]+")
API = "https://api.cloudflare.com/client/v4"

log = logging.getLogger("plan")


def run(*command: str) -> str:
    return subprocess.run(
        command, cwd=ROOT, stdout=subprocess.PIPE, text=True, check=True
    ).stdout.strip()


def digest(*parts: str) -> str:
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:24]


@cache
def system() -> str:
    return run("nix", "eval", "--raw", "--impure", "--expr", "builtins.currentSystem")


@cache
def flake() -> dict[str, str]:
    """flake.nix keys: the skolia Worker's out path and the sources'."""
    return json.loads(run("nix", "eval", "--json", f".#keys.{system()}"))


@cache
def analysis() -> dict[str, dict[str, str]]:
    """Each language's ingest image tag and cards lexicon out path (analysis/flake.nix)."""
    langs = " ".join(f'"{lang}"' for lang in LANGS)
    return json.loads(
        run(
            "nix",
            "eval",
            "--json",
            f"./analysis#packages.{system()}",
            "--apply",
            "p: builtins.listToAttrs (map (lang: { name = lang; value = {"
            ' image = p."ingest-${lang}".imageTag;'
            ' lexicon = p."cards-lexicon-${lang}".outPath; }; })'
            f" [ {langs} ])",
        )
    )


def describe(*args: str) -> str | None:
    """git describe --tags, or None if there's no such tag."""
    done = subprocess.run(
        ["git", "describe", "--tags", *args],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    return done.stdout.strip() if done.returncode == 0 else None


def version() -> str:
    if (tag := describe("--exact-match")) is not None:
        return tag
    worker = flake()["skolia-worker"].removeprefix("/nix/store/")[:12]
    return f"{describe('--abbrev=0') or 'untagged'}+{worker}"


@dataclass(frozen=True)
class Node:
    scope: Literal["build", "check", "deploy"]
    content: Callable[[], str] = lambda: ""
    build: tuple[str, ...] = ()
    test: tuple[str, ...] = ()


IMAGES = tuple(f"image-{lang}" for lang in LANGS)
PLAN_INFRA = tuple(f"plan-infra-{env}" for env in ("shared", "staging", "production"))

# Deploys in the order deploy.yml runs them. The end-to-end tests and the curated sync's
# script are in api/, so in the skolia Worker's source.
GRAPH: dict[str, Node] = {
    **{
        image: Node("build", lambda lang=lang: analysis()[lang]["image"])
        for image, lang in zip(IMAGES, LANGS)
    },
    "worker": Node("build", lambda: flake()["skolia-worker"]),
    "check": Node("check", lambda: flake()["repo"]),
    # The specs and their baselines, by git tree: the baselines are in git LFS, which the
    # planner doesn't check out, and a checkout with them would differ
    "screenshots": Node(
        "check",
        lambda: run("git", "rev-parse", "HEAD:reader/screenshots"),
        test=("worker",),
    ),
    "plan-infra-shared": Node("check", lambda: flake()["infra-shared"]),
    "plan-infra-staging": Node("check", test=("infra",)),
    "plan-infra-production": Node("check", test=("infra",)),
    "infra": Node("deploy", lambda: flake()["infra"]),
    "ingest": Node("deploy", lambda: flake()["ingest"], build=IMAGES),
    "lexicon": Node(
        "deploy", lambda: digest(*(analysis()[lang]["lexicon"] for lang in LANGS))
    ),
    "web": Node("deploy", version, build=("worker",)),
    "e2e": Node("deploy", test=("infra", "ingest", "lexicon", "web")),
    "curated": Node("deploy", lambda: flake()["curated"], test=("web",)),
}


def scope(of: str) -> list[str]:
    return [name for name, node in GRAPH.items() if node.scope == of]


@cache
def key(name: str) -> str:
    node = GRAPH[name]
    edges = [("build", dep) for dep in node.build] + [
        ("test", dep) for dep in node.test
    ]
    return digest(node.content(), *(f"{kind} {dep} {key(dep)}" for kind, dep in edges))


def quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def cloudflare(method: str, path: str, body: object = None) -> object:
    request = urllib.request.Request(
        f"{API}/accounts/{os.environ['CLOUDFLARE_ACCOUNT_ID']}/{path}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request) as response:
        return cast(dict[str, object], json.load(response))["result"]


@cache
def database() -> str:
    found = cast(
        list[dict[str, str]], cloudflare("GET", f"d1/database?name={DATABASE}")
    )
    return next(db["uuid"] for db in found if db["name"] == DATABASE)


def d1(sql: str) -> list[list[dict[str, object]]]:
    """Each statement's rows."""
    results = cast(
        list[dict[str, list[dict[str, object]]]],
        cloudflare("POST", f"d1/database/{database()}/query", {"sql": sql}),
    )
    return [result["results"] for result in results]


def has_token() -> bool:
    if os.environ.get("CLOUDFLARE_API_TOKEN"):
        return True
    log.warning("no CLOUDFLARE_API_TOKEN: every check runs, and none is recorded")
    return False


def built(names: list[str]) -> dict[str, bool]:
    """Whether each build or check has a row for its key: one seek each."""
    results = d1(
        " ".join(
            f"SELECT EXISTS (SELECT 1 FROM build WHERE package = {quote(name)} "
            f"AND key = {quote(key(name))}) AS done;"
            for name in names
        )
    )
    return {name: rows[0]["done"] == 1 for name, rows in zip(names, results)}


def deployed(env: str, names: list[str]) -> dict[str, bool]:
    """Whether each deploy's last row in env has its key: one seek each."""
    results = d1(
        " ".join(
            f"SELECT key FROM deployment WHERE env = {quote(env)} AND package = {quote(name)} "
            "ORDER BY id DESC LIMIT 1;"
            for name in names
        )
    )
    return {
        name: bool(rows) and rows[0]["key"] == key(name)
        for name, rows in zip(names, results)
    }


def needed(done: dict[str, bool], prefix: str = "") -> set[str]:
    for name, current in done.items():
        log.info(
            "%s%s: %s (%s)", prefix, name, "current" if current else "needed", key(name)
        )
    return {name for name, current in done.items() if not current}


def checks() -> dict[str, object]:
    names = scope("check")
    todo = needed(built(names) if has_token() else dict.fromkeys(names, False))
    return {
        "check": "check" in todo,
        "screenshots": "screenshots" in todo,
        "plan_infra": [
            name.removeprefix("plan-infra-") for name in PLAN_INFRA if name in todo
        ],
    }


def plan(env: str) -> dict[str, object]:
    todo = needed(built(scope("build")), "build ") | needed(
        deployed(env, scope("deploy")), f"{env} deploy "
    )
    return {
        "images": [lang for lang, image in zip(LANGS, IMAGES) if image in todo],
        "worker": "worker" in todo,
        **{name: name in todo for name in scope("deploy")},
    }


def record_build(name: str) -> None:
    d1(
        "INSERT INTO build (package, key, built_at) "
        f"VALUES ({quote(name)}, {quote(key(name))}, {quote(now())})"
    )
    log.info("built %s: %s", name, key(name))


def record_deployment(env: str, name: str, value: str | None) -> None:
    d1(
        "INSERT INTO deployment (env, package, key, deployed_at) "
        f"VALUES ({quote(env)}, {quote(name)}, {'NULL' if value is None else quote(value)}, {quote(now())})"
    )
    log.info("%s deployed %s: %s", env, name, value)


def main(args: list[str]) -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(name)s: %(message)s", stream=sys.stderr
    )
    match args:
        case ["version"]:
            print(version())
        case ["keys"]:
            for name, node in GRAPH.items():
                print(f"{node.scope} {name} {key(name)}")
        case ["checks"]:
            print(json.dumps(checks()))
        case ["passed", name] if name in scope("check"):
            if has_token():
                record_build(name)
        case ["built", name] if name in scope("build"):
            record_build(name)
        case ["deployed", env, name] if ENV.fullmatch(env) and name in scope("deploy"):
            record_deployment(env, name, key(name))
        case ["torn-down", env] if re.fullmatch(r"pr-[0-9]+", env):
            for name in scope("deploy"):
                record_deployment(env, name, None)
        case [env] if ENV.fullmatch(env):
            print(json.dumps(plan(env)))
        case _:
            print(__doc__, file=sys.stderr)
            raise SystemExit(2)


if __name__ == "__main__":
    main(sys.argv[1:])
