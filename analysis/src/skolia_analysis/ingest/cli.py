"""skolia-ingest: configured by environment variables, so the same image runs under
wrangler dev and on Cloudflare.

  SKOLIA_HTTP_PORT     takes jobs as POST /jobs on this port (see http.py)
  SKOLIA_BLOBS         the blob store's base URL (see HttpBlobs)
  SKOLIA_LANGS         languages to ingest, comma-separated, e.g. pl,en
  SKOLIA_DATA          the languages' data directory: {lang}.sqlite (skolia-build-lexicon)
                       and each plugin's own files (pl: pl-valency.json)
  SKOLIA_IMAGE         the container's image, named in each job's attempts; optional
  LOG_FORMAT           json for JSON Lines, otherwise logfmt
"""

import os
import signal
import sys
from pathlib import Path
from time import perf_counter
from types import FrameType

import structlog

from .. import lang
from ..lexicon.store import Lexicon
from ..log import configure_logging
from ..plugin import Options, lexicon_path
from .blobs import HttpBlobs
from .http import HttpJobs, serve
from .worker import Ingester, Pipeline

log = structlog.get_logger(module=__name__)


def env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f"skolia-ingest: set {name} (see skolia-ingest --help)")
    return value


def pipeline(code: str, data: Path) -> Pipeline:
    plugin = lang.plugin(code)
    log.info("loading pipeline", lang=code, model=plugin.DEFAULT_MODEL)
    parser = plugin.parser(plugin.DEFAULT_MODEL)
    analyzer = plugin.analyzer(parser, Options(plugin.DEFAULT_SNAP), data)
    lexicon = Lexicon(lexicon_path(data, code))
    return Pipeline(
        lang=code,
        analyze=analyzer,
        bundle=plugin.bundler(lexicon, data),
        analyzer=analyzer.name,
        lexicon_version=lexicon.version(),
    )


def stop_on_sigterm(_signum: int, _frame: FrameType | None) -> None:
    log.info("stopping", signal="SIGTERM")
    sys.exit(0)


def job_source() -> HttpJobs:
    """Listening starts before the pipeline loads (which takes a while), so the container
    counts as started and jobs wait in memory meanwhile."""
    port = int(env("SKOLIA_HTTP_PORT"))
    jobs = HttpJobs(os.environ.get("SKOLIA_IMAGE") or "unknown")
    serve(jobs, "0.0.0.0", port)
    log.info("accepting jobs", port=port)
    return jobs


def main() -> None:
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        return
    configure_logging()
    # In a container ingest is PID 1, which ignores SIGTERM unless it handles it: the
    # Cloudflare container would never stop it
    signal.signal(signal.SIGTERM, stop_on_sigterm)
    ingest(job_source())


def ingest(queue: HttpJobs) -> None:
    blobs = HttpBlobs(env("SKOLIA_BLOBS"))
    data = Path(env("SKOLIA_DATA"))
    codes = [c.strip() for c in env("SKOLIA_LANGS").split(",") if c.strip()]
    unknown = set(codes) - set(lang.LANGS)
    if unknown:
        sys.exit(f"skolia-ingest: unknown languages in SKOLIA_LANGS: {', '.join(sorted(unknown))}")
    started = perf_counter()
    pipelines = {code: pipeline(code, data) for code in codes}
    log.info("loaded pipelines in %.2f s", perf_counter() - started)

    ingester = Ingester(blobs, pipelines)
    started = perf_counter()
    ingester.publish_versions()
    log.info("published version metadata in %.2f s", perf_counter() - started)

    queue.loaded()
    log.info("waiting for jobs")
    ingester.run(queue)
