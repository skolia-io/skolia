#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""What a CI run and a deploy of an environment need to do: each target in the graph whose
key skolia-ci (infra/shared/ci.tf) has no record of.
  plan.py checks                        print the checks still to pass, as JSON, for ci.yml:
                                        {"check": true, "screenshots": false, "plan_infra": ["shared"]}
  plan.py passed <check>                record a check's pass
  plan.py <staging|production|pr-N>     print the deploy's plan as JSON, for deploy.yml:
                                        {"images": ["pl"], "worker": true, "infra": false, ...}
  plan.py built <build>                 record a build's key once it's in the registry or Cachix
  plan.py deployed <env> <deploy>       record a deploy's key once it's deployed
  plan.py torn-down <env>               record that a preview serves nothing (infra/teardown.sh)
  plan.py graph                         print each node's key and edges
  plan.py version                       the skolia Worker's version
The graph's nodes are projects (directories and files, named by path) and the targets CI
builds, checks and deploys. Each has content and edges: build edges (what it's made from)
and test edges (what it runs against). The pnpm projects' build edges are their package.json
workspace dependencies; the rest are in GRAPH. A node's key is a hash of its content and its
dependencies' keys, following build edges, and test edges too for a test: a check, or a
target with test edges of its own. A project's content is its files' Nix source (flake.nix
hashes), and a Nix build's its out path, which covers what it's built from, nixpkgs
included; nix eval gives both without building anything. A build or check is recorded once
for every environment (the build table), a deploy for each environment (deployment).
Without CLOUDFLARE_API_TOKEN (a fork's pull request) every check runs and none is recorded.
The version is the tag at HEAD, or else the last tag and the skolia Worker's out path hash
(v0.0.17+4qqk2ki3mxwb): not a commit, so a skipped deploy serves what a new one would.
Secrets aren't in any key: after changing one, deploy by hand. Needs the tags (a full
clone), CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.
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
BUILD = frozenset({"build"})
TEST = frozenset({"build", "test"})

log = logging.getLogger("plan")


def run(*command: str) -> str:
    return subprocess.run(
        command, cwd=ROOT, stdout=subprocess.PIPE, text=True, check=True
    ).stdout.strip()


def digest(*parts: str) -> str:
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:24]


@dataclass(frozen=True)
class Node:
    scope: Literal["project", "build", "check", "deploy"]
    # Content: these paths' Nix source, or else what this gives
    paths: tuple[str, ...] = ()
    content: Callable[[], str] = lambda: ""
    build: tuple[str, ...] = ()
    test: tuple[str, ...] = ()


@cache
def system() -> str:
    return run("nix", "eval", "--raw", "--impure", "--expr", "builtins.currentSystem")


@cache
def flake() -> dict[str, object]:
    """The skolia Worker's out path, and each project's source (flake.nix planner)."""
    paths = {name: node.paths for name, node in graph().items() if node.paths}
    return json.loads(
        run(
            "nix",
            "eval",
            "--json",
            ".#planner",
            "--apply",
            f"p: {{ worker = p.worker.{system()}; "
            f"hashes = p.hashes (builtins.fromJSON ''{json.dumps(paths)}''); }}",
        )
    )


def worker() -> str:
    return cast(str, flake()["worker"])


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
    return f"{describe('--abbrev=0') or 'untagged'}+{worker().removeprefix('/nix/store/')[:12]}"


def pnpm_projects() -> dict[str, Node]:
    """Each pnpm-workspace.yaml package, built on its workspace dependencies and the lock files."""
    dirs = re.findall(
        r"^  - (\S+)$",
        (ROOT / "pnpm-workspace.yaml").read_text().split("\n\n")[0],
        re.MULTILINE,
    )
    manifests = {d: json.loads((ROOT / d / "package.json").read_text()) for d in dirs}
    by_name = {manifest["name"]: f"{d}/" for d, manifest in manifests.items()}

    def workspace(manifest: dict[str, dict[str, str]], *fields: str) -> tuple[str, ...]:
        return tuple(
            sorted(
                by_name[dep]
                for field in fields
                for dep, spec in manifest.get(field, {}).items()
                if spec.startswith("workspace:")
            )
        )

    return {
        f"{d}/": Node(
            "project",
            paths=(d,),
            build=(
                "workspace",
                *workspace(manifest, "dependencies", "devDependencies"),
            ),
            test=workspace(manifest, "testDependencies"),
        )
        for d, manifest in manifests.items()
    }


IMAGES = tuple(f"image-{lang}" for lang in LANGS)
PLAN_INFRA = tuple(f"plan-infra-{env}" for env in ("shared", "staging", "production"))
MIGRATIONS = ("api/migrations/", "api/lexicon-migrations/", "ingest/migrations/")
BASELINES = "reader/screenshots/__screenshots__/"


@cache
def graph() -> dict[str, Node]:
    projects: dict[str, Node] = {
        **pnpm_projects(),
        "workspace": Node(
            "project",
            paths=(
                "package.json",
                "pnpm-lock.yaml",
                "pnpm-workspace.yaml",
                "biome.json",
            ),
        ),
        # What CI's tools come from, and the recipes it runs
        "tooling": Node("project", paths=("flake.nix", "flake.lock", "justfile")),
        "analysis/": Node("project", paths=("analysis",)),
        "curated/": Node("project", paths=("curated",)),
        # Terraform's resources (not shared/ or tokens/, their own environments)
        "infra/": Node(
            "project",
            paths=(
                *sorted(f"infra/{tf.name}" for tf in (ROOT / "infra").glob("*.tf")),
                "infra/.terraform.lock.hcl",
                "infra/terraformrc",
                "infra/tf.sh",
                "infra/wrangler.sh",
            ),
        ),
        "infra/shared/": Node(
            "project", paths=("infra/shared", "infra/terraformrc", "infra/tf.sh")
        ),
        **{m: Node("project", paths=(m.rstrip("/"),)) for m in MIGRATIONS},
        # By git tree: they're in git LFS, which the planner doesn't check out
        BASELINES: Node(
            "project",
            content=lambda: run("git", "rev-parse", f"HEAD:{BASELINES.rstrip('/')}"),
        ),
    }
    # Deploys in the order deploy.yml runs them
    targets: dict[str, Node] = {
        **{
            image: Node("build", content=lambda lang=lang: analysis()[lang]["image"])
            for image, lang in zip(IMAGES, LANGS)
        },
        "worker": Node("build", content=worker),
        # just check and just test
        "check": Node("check", build=tuple(projects)),
        "screenshots": Node("check", build=("tooling",), test=("reader/", BASELINES)),
        "plan-infra-shared": Node("check", build=("tooling",), test=("infra/shared/",)),
        "plan-infra-staging": Node("check", build=("tooling",), test=("infra/",)),
        "plan-infra-production": Node("check", build=("tooling",), test=("infra/",)),
        "infra": Node("deploy", build=("infra/", *MIGRATIONS)),
        "ingest": Node("deploy", build=("ingest/", *IMAGES)),
        "lexicon": Node(
            "deploy",
            content=lambda: digest(*(analysis()[lang]["lexicon"] for lang in LANGS)),
        ),
        "web": Node("deploy", content=version, build=("worker",)),
        # The tests are in api/, so in the skolia Worker
        "e2e": Node("deploy", test=("infra", "ingest", "lexicon", "web")),
        "curated": Node("deploy", test=("curated/", "web")),
    }
    return projects | targets


def scope(of: str) -> list[str]:
    return [name for name, node in graph().items() if node.scope == of]


def content(name: str) -> str:
    node = graph()[name]
    if node.paths:
        return cast(dict[str, str], flake()["hashes"])[name]
    return node.content()


@cache
def node_key(name: str, kinds: frozenset[str], path: tuple[str, ...] = ()) -> str:
    if name in path:
        raise SystemExit(f"a cycle in the graph: {' -> '.join((*path, name))}")
    node = graph()[name]
    edges = [
        (kind, dep)
        for kind, deps in (("build", node.build), ("test", node.test))
        if kind in kinds
        for dep in deps
    ]
    return digest(
        content(name),
        *(f"{kind} {dep} {node_key(dep, kinds, (*path, name))}" for kind, dep in edges),
    )


def key(name: str) -> str:
    """A test's key follows test edges too, everything else's only build edges."""
    node = graph()[name]
    return node_key(name, TEST if node.scope == "check" or node.test else BUILD)


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
        case ["graph"]:
            for name, node in graph().items():
                edges = [f"build:{dep}" for dep in node.build] + [
                    f"test:{dep}" for dep in node.test
                ]
                print(f"{node.scope} {name} {key(name)} {' '.join(edges)}".rstrip())
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
