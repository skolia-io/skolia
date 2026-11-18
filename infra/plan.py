#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""What a CI run needs to do: each target whose key skolia-ci (infra/shared/ci.tf) has no
record of, as ci-planner does it, with Nix hashes where it has git trees.

The graph's nodes are paths and Nix packages (./analysis#ingest-pl), and its edges are read
from the manifests a path has (direct_deps): a package.json's workspace dependencies (build;
testDependencies, test) and the lock files (NODE_BASE); a Terraform root's local modules and
the tools that run it (TERRAFORM_BASE); and STATIC, what no manifest says. A Nix package has
no edges: its out path covers what it's built from. A node's checksum is a hash of its
version and its dependencies' checksums. Its version is its files' Nix source (flake.nix
planner.hashes; a Terraform root's is its *.tf and lock file, what terraform reads), a Nix
package's out path, or a git tree for what's in git LFS, which the planner doesn't check out.

The targets (TARGETS) are what CI's jobs build, check and deploy, each on nodes it's made from
(build), nodes it runs against (test) and targets it runs against once they're deployed
(against). A target's key hashes those nodes' checksums, following test edges too for a test,
and the keys of what it runs against. A build or check is recorded once for every
environment (the build table), a deploy for each environment (deployment): staging,
production and pr-<N>, or shared, the account's that aren't any environment's.

A preview that has never been deployed and whose every deploy would match staging's is
skipped: it would be staging. Without CLOUDFLARE_API_TOKEN (a fork's pull request) every
check runs and none is recorded. The version is the tag at HEAD, or else the last tag and
the skolia Worker's out path hash (v0.0.17+4qqk2ki3mxwb): not a commit, so a skipped deploy
serves what a new one would. Secrets aren't in any key: after changing one, deploy by hand.
Needs the tags (a full clone), CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.
"""

import argparse
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
from functools import cache, cached_property
from pathlib import Path
from typing import Literal, cast

ROOT = Path(__file__).resolve().parent.parent
LANGS = ("pl", "en", "fr")
DATABASE = "skolia-ci"
ENV = re.compile(r"staging|production|pr-[0-9]+")
API = "https://api.cloudflare.com/client/v4"

type Kind = Literal["build", "test"]
type Kinds = frozenset[Kind]
BUILD: Kinds = frozenset({"build"})
TEST: Kinds = frozenset({"build", "test"})

# What no manifest says, as ci-planner.yaml's node_base_dependency and static_dependencies.
# Every package.json project builds on the workspace's lock files
NODE_BASE = ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml")
# and every Terraform root on the terraform the flake pins and the script that runs it
TERRAFORM_BASE = ("flake.nix", "flake.lock", "infra/tf.sh", "infra/terraformrc")
# Keyed by git tree: git LFS, which the planner doesn't check out
LFS = ("reader/screenshots/__screenshots__",)
STATIC: dict[str, dict[Kind, tuple[str, ...]]] = {
    # The reader's screenshots: the specs, run against the reader, and their baselines
    "reader/screenshots": {"build": ("reader",), "test": LFS},
}

log = logging.getLogger("plan")


def run(*command: str) -> str:
    return subprocess.run(
        command, cwd=ROOT, stdout=subprocess.PIPE, text=True, check=True
    ).stdout.strip()


def digest(*parts: str) -> str:
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:24]


def normalize(path: str) -> str:
    return os.path.normpath(path)


def read_jsonc(path: Path) -> dict[str, object]:
    """A wrangler.jsonc: JSON with comments and trailing commas."""
    text, out, i = path.read_text(), [], 0
    while i < len(text):
        if text[i] == '"':
            end = i + 1
            while text[end] != '"':
                end += 2 if text[end] == "\\" else 1
            out.append(text[i : end + 1])
            i = end + 1
        elif text.startswith("//", i):
            i = text.find("\n", i)
        elif text.startswith("/*", i):
            i = text.index("*/", i) + 2
        else:
            out.append(text[i])
            i += 1
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", "".join(out)))


# Manifests


def edge(kind: Kind, dep: str) -> tuple[Kind, str]:
    return (kind, dep)


def build(dep: str) -> tuple[Kind, str]:
    return edge("build", dep)


@cache
def packages() -> dict[str, str]:
    """Each pnpm-workspace.yaml package's directory, by its package.json name."""
    workspace = (ROOT / "pnpm-workspace.yaml").read_text().split("\n\n")[0]
    dirs = re.findall(r"^  - (\S+)$", workspace, re.MULTILINE)
    return {
        json.loads((ROOT / d / "package.json").read_text())["name"]: d for d in dirs
    }


def npm_deps(node: str) -> list[tuple[Kind, str]]:
    manifest = json.loads((ROOT / node / "package.json").read_text())
    fields: dict[str, Kind] = {
        "dependencies": "build",
        "devDependencies": "build",
        "testDependencies": "test",
    }
    return [build(base) for base in NODE_BASE] + [
        (kind, packages()[dep])
        for field, kind in fields.items()
        for dep, spec in manifest.get(field, {}).items()
        if spec.startswith("workspace:")
    ]


def is_terraform_root(node: str) -> bool:
    return (ROOT / node).is_dir() and any((ROOT / node).glob("*.tf"))


def terraform_files(node: str) -> list[str]:
    files = sorted(f"{node}/{tf.name}" for tf in (ROOT / node).glob("*.tf"))
    return [*files, f"{node}/.terraform.lock.hcl"]


def terraform_deps(node: str) -> list[tuple[Kind, str]]:
    modules = {
        normalize(f"{node}/{source}")
        for tf in terraform_files(node)[:-1]
        for source in re.findall(
            r'source\s*=\s*"(\.\.?/[^"]+)"', (ROOT / tf).read_text()
        )
    }
    return [build(dep) for dep in (*TERRAFORM_BASE, *sorted(modules))]


def migrations(config: str) -> tuple[str, ...]:
    """The D1 migrations a wrangler config applies, at the top level and in each env."""
    wrangler = read_jsonc(ROOT / config)
    scopes = [
        wrangler,
        *cast(dict[str, dict[str, object]], wrangler.get("env", {})).values(),
    ]
    return tuple(
        sorted(
            {
                normalize(f"{Path(config).parent}/{db['migrations_dir']}")
                for scope in scopes
                for db in cast(list[dict[str, str]], scope.get("d1_databases", []))
                if "migrations_dir" in db
            }
        )
    )


@cache
def direct_deps(node: str) -> tuple[tuple[Kind, str], ...]:
    """A node's edges, from its manifests and STATIC."""
    deps: list[tuple[Kind, str]] = []
    if "#" not in node and node not in LFS:
        if node in packages().values():
            deps += npm_deps(node)
        if is_terraform_root(node):
            deps += terraform_deps(node)
    if node in STATIC:
        deps += [
            edge(kind, dep) for kind, static in STATIC[node].items() for dep in static
        ]
    return tuple(dict.fromkeys(dep for dep in deps if dep[1] != node))


# Targets


@dataclass(frozen=True)
class Target:
    scope: Literal["build", "check", "deploy", "shared"]
    build: tuple[str, ...] = ()
    test: tuple[str, ...] = ()
    against: tuple[str, ...] = ()
    content: Callable[["Planner"], str] = lambda _: ""

    @property
    def kinds(self) -> Kinds:
        return TEST if self.scope == "check" or self.test or self.against else BUILD


IMAGES = tuple(f"image-{lang}" for lang in LANGS)
PLAN_INFRA = {"shared": "infra/shared", "staging": "infra", "production": "infra"}


@cache
def targets() -> dict[str, Target]:
    """CI's jobs: builds, checks, each environment's deploys in the order deploy.yml runs
    them, and the shared deploys."""
    return {
        **{
            image: Target("build", (f"./analysis#ingest-{lang}",))
            for image, lang in zip(IMAGES, LANGS)
        },
        "worker": Target("build", (".#skolia-worker",)),
        # just check and just test read everything
        "check": Target("check", test=(".",)),
        "screenshots": Target("check", test=("reader/screenshots",)),
        **{
            f"plan-infra-{env}": Target("check", test=(root,))
            for env, root in PLAN_INFRA.items()
        },
        "infra": Target("deploy", ("infra", *migrations("api/wrangler.jsonc"))),
        "ingest": Target(
            "deploy", ("ingest", *(f"./analysis#ingest-{lang}" for lang in LANGS))
        ),
        "lexicon": Target(
            "deploy", tuple(f"./analysis#cards-lexicon-{lang}" for lang in LANGS)
        ),
        "web": Target(
            "deploy", (".#skolia-worker",), content=lambda planner: planner.version()
        ),
        # The tests are in api/, so in the skolia Worker
        "e2e": Target("deploy", against=("infra", "ingest", "lexicon", "web")),
        "curated": Target("deploy", test=("curated",), against=("web",)),
        "infra-shared": Target(
            "shared", ("infra/shared", *migrations("infra/skolia-ci/wrangler.jsonc"))
        ),
        "oauth-proxy": Target("shared", ("oauth-proxy",)),
    }


def scope(of: str) -> list[str]:
    return [name for name, target in targets().items() if target.scope == of]


# Versions and keys


def reach(names: list[str]) -> tuple[list[str], list[str]]:
    """The targets named and those they run against, and every node those reach."""
    chosen: dict[str, None] = {}
    pending = list(names)
    while pending:
        if (name := pending.pop()) not in chosen:
            chosen[name] = None
            pending += targets()[name].against
    reached: dict[str, None] = {}
    todo = [
        n for name in chosen for n in (*targets()[name].build, *targets()[name].test)
    ]
    while todo:
        if (node := todo.pop()) not in reached:
            reached[node] = None
            todo += [dep for _, dep in direct_deps(node)]
    return [name for name in targets() if name in chosen], list(reached)


@cache
def system() -> str:
    return run("nix", "eval", "--raw", "--impure", "--expr", "builtins.currentSystem")


def nix_eval(flake: str, attr: str, apply: str) -> dict[str, str]:
    return json.loads(run("nix", "eval", "--json", f"{flake}#{attr}", "--apply", apply))


def out_paths(attrs: list[str]) -> str:
    return "{ " + " ".join(f'"{a}" = packages."{a}".outPath;' for a in attrs) + " }"


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


class Planner:
    """The keys of some targets and of the nodes they reach, as ci-planner's Planner. It
    evaluates only those nodes' versions, one nix eval per flake: the screenshots job runs on
    aarch64-linux, which the analysis flake doesn't build for."""

    def __init__(self, names: list[str]) -> None:
        self.targets, self.nodes = reach(names)
        self.checksums: dict[tuple[str, Kinds], str] = {}
        self.keys: dict[str, str] = {}

    @cached_property
    def versions(self) -> dict[str, str]:
        """Each node's version but an LFS one's."""
        sources = {
            node: terraform_files(node) if is_terraform_root(node) else [node]
            for node in self.nodes
            if "#" not in node and node not in LFS
        }
        flakes: dict[str, list[str]] = {}
        for node in self.nodes:
            if "#" in node:
                flake, attr = node.split("#")
                flakes.setdefault(flake, []).append(attr)
        root = flakes.pop(".", [])
        found = nix_eval(
            ".",
            "planner",
            f"p: let packages = p.packages.{system()}; in "
            f"{{ sources = p.hashes (builtins.fromJSON ''{json.dumps(sources)}''); "
            f"packages = {out_paths(root)}; }}",
        )
        result = cast(dict[str, str], found["sources"]) | {
            f".#{attr}": path
            for attr, path in cast(dict[str, str], found["packages"]).items()
        }
        for flake, attrs in flakes.items():
            built = nix_eval(
                flake, f"packages.{system()}", f"packages: {out_paths(attrs)}"
            )
            result |= {f"{flake}#{attr}": path for attr, path in built.items()}
        return result

    def node_version(self, node: str) -> str:
        if node in LFS:
            return run("git", "rev-parse", f"HEAD:{node}")
        return self.versions[node]

    def version(self) -> str:
        """The skolia Worker's."""
        if (tag := describe("--exact-match")) is not None:
            return tag
        worker = self.versions[".#skolia-worker"].removeprefix("/nix/store/")[:12]
        return f"{describe('--abbrev=0') or 'untagged'}+{worker}"

    def checksum(self, node: str, kinds: Kinds, path: tuple[str, ...] = ()) -> str:
        if node in path:
            raise SystemExit(f"a cycle in the graph: {' -> '.join((*path, node))}")
        if (node, kinds) not in self.checksums:
            deps = [(kind, dep) for kind, dep in direct_deps(node) if kind in kinds]
            self.checksums[node, kinds] = digest(
                self.node_version(node),
                *(
                    f"{kind} {dep} {self.checksum(dep, kinds, (*path, node))}"
                    for kind, dep in deps
                ),
            )
        return self.checksums[node, kinds]

    def key(self, name: str) -> str:
        if name not in self.keys:
            target = targets()[name]
            self.keys[name] = digest(
                target.content(self),
                *(f"build {n} {self.checksum(n, target.kinds)}" for n in target.build),
                *(f"test {n} {self.checksum(n, target.kinds)}" for n in target.test),
                *(f"against {dep} {self.key(dep)}" for dep in target.against),
            )
        return self.keys[name]


# skolia-ci


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
    if not sql:
        return []
    results = cast(
        list[dict[str, list[dict[str, object]]]],
        cloudflare("POST", f"d1/database/{database()}/query", {"sql": sql}),
    )
    return [result["results"] for result in results]


@cache
def has_token() -> bool:
    if os.environ.get("CLOUDFLARE_API_TOKEN"):
        return True
    log.warning(
        "no CLOUDFLARE_API_TOKEN: everything is needed, and nothing is recorded"
    )
    return False


NEVER_RECORDED = "never recorded"


def built(planner: Planner, names: list[str]) -> tuple[dict[str, bool], dict[str, str]]:
    """Whether each build or check has a row for its key, and its last row's key (or
    NEVER_RECORDED): two seeks each."""
    results = d1(
        " ".join(
            f"SELECT EXISTS (SELECT 1 FROM build WHERE package = {quote(name)} "
            f"AND key = {quote(planner.key(name))}) AS done, "
            f"(SELECT key FROM build WHERE package = {quote(name)} ORDER BY id DESC LIMIT 1) AS last;"
            for name in names
        )
    )
    rows = [result[0] for result in results]
    return (
        {name: row["done"] == 1 for name, row in zip(names, rows)},
        {
            name: cast(str | None, row["last"]) or NEVER_RECORDED
            for name, row in zip(names, rows)
        },
    )


NEVER_DEPLOYED = "never deployed"
TORN_DOWN = "torn down"


def last_keys(env: str, names: list[str]) -> dict[str, str]:
    """Each deploy's last row's key in env, or NEVER_DEPLOYED or TORN_DOWN (a row with no
    key): one seek each."""
    results = d1(
        " ".join(
            f"SELECT key FROM deployment WHERE env = {quote(env)} AND package = {quote(name)} "
            "ORDER BY id DESC LIMIT 1;"
            for name in names
        )
    )
    return {
        name: cast(str | None, rows[0]["key"]) or TORN_DOWN if rows else NEVER_DEPLOYED
        for name, rows in zip(names, results)
    }


# The plan


def short(key: str) -> str:
    return key[:12] if re.fullmatch(r"[0-9a-f]{24}", key) else key


def needed(
    planner: Planner,
    heading: str,
    done: dict[str, bool],
    before: dict[str, str] | None = None,
) -> dict[str, bool]:
    """Whether each is needed, logged as a table under heading: its key, and for one that's
    needed what it replaces, when that's known (a deploy's last key in its environment)."""
    log.info("%s", heading)
    width = max(map(len, done))
    for name, current in done.items():
        key = short(planner.key(name))
        if current:
            log.info("  %-*s  current  %s", width, name, key)
        elif before is not None:
            log.info("  %-*s  needed   %s -> %s", width, name, short(before[name]), key)
        else:
            log.info("  %-*s  needed   %s", width, name, key)
    return {name: not current for name, current in done.items()}


def plan_deploys(planner: Planner, env: str) -> dict[str, bool] | None:
    """Whether each of env's deploys is needed, or None for a preview that would be staging."""
    names = scope("shared" if env == "shared" else "deploy")
    if not has_token():
        return needed(planner, f"{env}, deploys", dict.fromkeys(names, False))
    keys = {name: planner.key(name) for name in names}
    last = last_keys(env, names)
    unserved = all(value in (NEVER_DEPLOYED, TORN_DOWN) for value in last.values())
    if env.startswith("pr-") and unserved and last_keys("staging", names) == keys:
        log.info("%s: skipped, as it's never been deployed and would be staging", env)
        return None
    return needed(
        planner,
        f"{env}, deploys",
        {name: last[name] == keys[name] for name in names},
        last,
    )


def plan(planner: Planner, envs: list[str]) -> dict[str, object]:
    """The run's: the checks still to pass, and each env's deploys with the builds they need
    (none for a preview that would be staging). terraform is whether anything needs the
    providers mirrored (ci.yml mirror-providers)."""

    def recorded(names: list[str]) -> tuple[dict[str, bool], dict[str, str] | None]:
        return (
            built(planner, names)
            if has_token()
            else (dict.fromkeys(names, False), None)
        )

    check = needed(
        planner, "checks, once for every environment", *recorded(scope("check"))
    )
    unbuilt = needed(
        planner, "builds, once for every environment", *recorded(scope("build"))
    )
    deploys: dict[str, dict[str, object]] = {}
    for env in envs:
        if (todo := plan_deploys(planner, env)) is None:
            continue
        deploys[env] = dict(todo)
        if env != "shared":
            # The lexicon loads from the images' venv (just load-lexicon)
            images = todo["ingest"] or todo["lexicon"]
            deploys[env]["images"] = [
                lang for lang, image in zip(LANGS, IMAGES) if images and unbuilt[image]
            ]
            deploys[env]["worker"] = todo["web"] and unbuilt["worker"]
    plan_infra = [env for env in PLAN_INFRA if check[f"plan-infra-{env}"]]
    deploying = any(
        value is True for todo in deploys.values() for value in todo.values()
    )
    count = sum(check.values()) + sum(
        value is True for todo in deploys.values() for value in todo.values()
    )
    log.info(
        "%d to do: the checks and deploys marked needed, and the builds they need",
        count,
    )
    return {
        "check": check["check"],
        "screenshots": check["screenshots"],
        "plan_infra": plan_infra,
        "terraform": check["check"] or bool(plan_infra) or deploying,
        "deploys": deploys,
    }


def record_build(planner: Planner, name: str) -> None:
    d1(
        "INSERT INTO build (package, key, built_at) "
        f"VALUES ({quote(name)}, {quote(planner.key(name))}, {quote(now())})"
    )
    log.info("built %s: %s", name, planner.key(name))


def record_deployment(env: str, name: str, value: str | None) -> None:
    d1(
        "INSERT INTO deployment (env, package, key, deployed_at) "
        f"VALUES ({quote(env)}, {quote(name)}, {'NULL' if value is None else quote(value)}, {quote(now())})"
    )
    log.info("%s %s %s: %s", env, "deployed" if value else "deploying", name, value)


# The graph, to read


def print_graph(planner: Planner, as_dot: bool) -> None:
    """The planner's targets and the nodes they reach."""
    chosen, reached = planner.targets, planner.nodes
    if not as_dot:
        for name in chosen:
            target = targets()[name]
            edges = [f"build:{n}" for n in target.build] + [
                f"test:{n}" for n in target.test
            ]
            edges += [f"against:{t}" for t in target.against]
            print(
                f"{target.scope} {name} {planner.key(name)} {' '.join(edges)}".rstrip()
            )
        for node in sorted(reached):
            edges = [f"{kind}:{dep}" for kind, dep in direct_deps(node)]
            print(
                f"node {node} {planner.checksum(node, TEST)} {' '.join(edges)}".rstrip()
            )
        return
    shapes = {
        "build": "box",
        "check": "diamond",
        "deploy": "ellipse",
        "shared": "ellipse",
    }
    lines = ["digraph plan {", "  rankdir=LR;", "  node [fontname=Helvetica];"]
    for name in chosen:
        target = targets()[name]
        lines.append(
            f'  "target:{name}" [shape={shapes[target.scope]}, label="{name}"];'
        )
        lines += [f'  "target:{name}" -> "{n}";' for n in target.build]
        lines += [f'  "target:{name}" -> "{n}" [style=dashed];' for n in target.test]
        lines += [
            f'  "target:{name}" -> "target:{t}" [style=dotted];' for t in target.against
        ]
    for node in sorted(reached):
        lines.append(f'  "{node}" [shape=folder];')
        for kind, dep in direct_deps(node):
            style = " [style=dashed]" if kind == "test" else ""
            lines.append(f'  "{node}" -> "{dep}"{style};')
    print("\n".join([*lines, "}"]))


def environment(value: str) -> str:
    if value != "shared" and not ENV.fullmatch(value):
        raise argparse.ArgumentTypeError(
            f"not staging, production, pr-<N> or shared: {value}"
        )
    return value


def preview(value: str) -> str:
    if not re.fullmatch(r"pr-[0-9]+", value):
        raise argparse.ArgumentTypeError(f"not pr-<N>: {value}")
    return value


def main(args: list[str]) -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stderr)
    parser = argparse.ArgumentParser(
        prog="plan.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser(
        "plan",
        help="print the run's plan as JSON, for ci.yml: the checks, the builds, and each "
        "environment's deploys",
    ).add_argument("envs", nargs="*", type=environment, metavar="env")
    commands.add_parser("passed", help="record a check's pass").add_argument(
        "name", choices=scope("check")
    )
    commands.add_parser(
        "built", help="record a build's key once it's in the registry or Cachix"
    ).add_argument("name", choices=scope("build"))
    for command, help in (
        ("deploying", "record that a deploy has started, before it changes anything"),
        ("deployed", "record a deploy's key once it's deployed"),
    ):
        deploy = commands.add_parser(command, help=help)
        deploy.add_argument("env", type=environment)
        deploy.add_argument("name", choices=scope("deploy") + scope("shared"))
    commands.add_parser(
        "torn-down", help="record that a preview serves nothing (infra/teardown.sh)"
    ).add_argument("env", type=preview)
    graph = commands.add_parser(
        "graph",
        help="print targets' keys and edges, and the nodes they reach (every target by default)",
    )
    graph.add_argument(
        "--dot", action="store_true", help="as Graphviz: | dot -Tsvg >plan.svg"
    )
    graph.add_argument("names", nargs="*", choices=list(targets()), metavar="target")
    commands.add_parser("version", help="print the skolia Worker's version")

    parsed = parser.parse_args(args)
    match parsed.command:
        case "plan":
            print(json.dumps(plan(Planner(list(targets())), parsed.envs)))
        case "passed":
            if has_token():
                record_build(Planner([parsed.name]), parsed.name)
        case "built":
            record_build(Planner([parsed.name]), parsed.name)
        case "deploying":
            record_deployment(parsed.env, parsed.name, None)
        case "deployed":
            key = Planner([parsed.name]).key(parsed.name)
            record_deployment(parsed.env, parsed.name, key)
        case "torn-down":
            for name in scope("deploy"):
                record_deployment(parsed.env, name, None)
        case "graph":
            print_graph(Planner(parsed.names or list(targets())), parsed.dot)
        case "version":
            print(Planner(["web"]).version())


if __name__ == "__main__":
    main(sys.argv[1:])
