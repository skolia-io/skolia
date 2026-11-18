#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""What a deploy of an environment needs to do, from skolia-ci (infra/shared/ci.tf): what's
been built, for every environment (build), and what each environment serves (deployment).
  plan.py <staging|production|pr-N>     print the plan as JSON, for deploy.yml:
                                        {"images": ["pl"], "worker": true, "ingest": true, "lexicon": false, ...}
  plan.py built <build>                 record a build's key once it's in the registry or Cachix
  plan.py deployed <env> <deploy>       record a deploy's key once it's deployed
  plan.py torn-down <env>               record that a preview serves nothing (infra/teardown.sh)
  plan.py version                       the skolia Worker's version
A key is a hash of Nix outputs, which nix eval gives without building anything. Builds,
each built once for every environment:
  image-<lang>   the ingest image (analysis#ingest-<lang>.imageTag), in the registry
  worker         the skolia Worker (flake.nix skolia-worker), in Cachix
Deploys, each environment's:
  ingest         the image tags and the source the ingest Worker is bundled from
                 (flake.nix sources.ingest)
  lexicon        each language's cards lexicon (analysis#cards-lexicon-<lang>)
  web            the skolia Worker and its version
  e2e            the end-to-end tests, run against ingest, lexicon and web
  curated        the curated texts' sync (flake.nix sources.curated), against web
The version is the tag at HEAD, or else the last tag and the skolia Worker's out path hash
(v0.0.17+4qqk2ki3mxwb): not a commit, so a skipped deploy serves what a new one would.
Secrets aren't in any key: after changing one, deploy by hand. Needs the tags (a full
clone) and the credentials infra/wrangler.sh needs.
"""

import hashlib
import json
import logging
import re
import subprocess
import sys
from collections.abc import Callable
from datetime import UTC, datetime
from functools import cache
from pathlib import Path
from typing import cast

ROOT = Path(__file__).resolve().parent.parent
LANGS = ("pl", "en", "fr")
DATABASE = "skolia-ci"
ENV = re.compile(r"staging|production|pr-[0-9]+")

log = logging.getLogger("plan")


def run(*command: str) -> str:
    return subprocess.run(
        command, cwd=ROOT, stdout=subprocess.PIPE, text=True, check=True
    ).stdout.strip()


@cache
def nix_eval(attr: str) -> str:
    return run("nix", "eval", "--raw", attr)


def digest(*parts: str) -> str:
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:24]


def image_tag(lang: str) -> str:
    return nix_eval(f"./analysis#ingest-{lang}.imageTag")


def worker() -> str:
    return nix_eval(".#skolia-worker.outPath")


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


BUILDS: dict[str, Callable[[], str]] = {
    **{f"image-{lang}": (lambda lang=lang: image_tag(lang)) for lang in LANGS},
    "worker": worker,
}


def ingest() -> str:
    tags = (f"{lang} {image_tag(lang)}" for lang in LANGS)
    return digest(*tags, nix_eval(".#sources.ingest.outPath"))


def lexicon() -> str:
    return digest(*(nix_eval(f"./analysis#cards-lexicon-{lang}.outPath") for lang in LANGS))


def web() -> str:
    return digest(version(), worker())


# In the order deploy.yml runs them: the end-to-end tests and the curated sync go last, and
# their keys hold the deploys they ran against. The tests and the sync script are in api/,
# so in the skolia Worker's key.
DEPLOYS: dict[str, Callable[[], str]] = {
    "ingest": ingest,
    "lexicon": lexicon,
    "web": web,
    "e2e": lambda: digest(ingest(), lexicon(), web()),
    "curated": lambda: digest(nix_eval(".#sources.curated.outPath"), web()),
}


def quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def d1(sql: str) -> list[list[dict[str, str]]]:
    """Each statement's rows."""
    out = run(
        str(ROOT / "infra" / "wrangler.sh"),
        *("account", "d1", "execute", DATABASE, "--remote", "--json", "--command", sql),
    )
    return [
        result["results"] for result in cast(list[dict[str, list[dict[str, str]]]], json.loads(out))
    ]


def plan(env: str) -> dict[str, object]:
    builds = {package: key() for package, key in BUILDS.items()}
    deploys = {package: key() for package, key in DEPLOYS.items()}
    # One statement each, every one a seek: whether the build has a row, and the
    # deployment's last row
    results = d1(
        " ".join(
            [
                f"SELECT EXISTS (SELECT 1 FROM build WHERE package = {quote(package)} "
                f"AND key = {quote(key)}) AS done;"
                for package, key in builds.items()
            ]
            + [
                f"SELECT key FROM deployment WHERE env = {quote(env)} AND package = {quote(package)} "
                "ORDER BY id DESC LIMIT 1;"
                for package in deploys
            ]
        )
    )
    built = {package: rows[0]["done"] == 1 for package, rows in zip(builds, results)}
    deployed = {
        package: rows[0]["key"] if rows else None
        for package, rows in zip(deploys, results[len(builds) :])
    }

    def needed(what: str, package: str, key: str, done: bool) -> bool:
        log.info("%s %s %s: %s (%s)", env, what, package, "current" if done else "needed", key)
        return not done

    def build(package: str) -> bool:
        return needed("build", package, builds[package], built[package])

    def deploy(package: str) -> bool:
        return needed("deploy", package, deploys[package], deployed[package] == deploys[package])

    return {
        "images": [lang for lang in LANGS if build(f"image-{lang}")],
        "worker": build("worker"),
        "ingest": deploy("ingest"),
        "lexicon": deploy("lexicon"),
        "web": deploy("web"),
        "e2e": deploy("e2e"),
        "curated": deploy("curated"),
    }


def record_build(package: str) -> None:
    key = BUILDS[package]()
    d1(
        f"INSERT INTO build (package, key, built_at) VALUES ({quote(package)}, {quote(key)}, {quote(now())})"
    )
    log.info("built %s: %s", package, key)


def record_deployment(env: str, package: str, key: str | None) -> None:
    value = "NULL" if key is None else quote(key)
    d1(
        "INSERT INTO deployment (env, package, key, deployed_at) "
        f"VALUES ({quote(env)}, {quote(package)}, {value}, {quote(now())})"
    )
    log.info("%s deployed %s: %s", env, package, key)


def main(args: list[str]) -> None:
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s", stream=sys.stderr)
    match args:
        case ["version"]:
            print(version())
        case ["built", package] if package in BUILDS:
            record_build(package)
        case ["deployed", env, package] if ENV.fullmatch(env) and package in DEPLOYS:
            record_deployment(env, package, DEPLOYS[package]())
        case ["torn-down", env] if re.fullmatch(r"pr-[0-9]+", env):
            for package in DEPLOYS:
                record_deployment(env, package, None)
        case [env] if ENV.fullmatch(env):
            print(json.dumps(plan(env)))
        case _:
            print(__doc__, file=sys.stderr)
            raise SystemExit(2)


if __name__ == "__main__":
    main(sys.argv[1:])
