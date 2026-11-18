"""Process import jobs: text blob -> analysis + bundle blobs. The run that asked for a job
keeps the document's status (ingest/src/workflow.ts), from the job's result."""

import json
import logging
import time
from collections.abc import Callable, Generator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Literal, cast

import brotli

from ..blob import SCHEMA
from ..lexicon.schema import BUNDLE_SCHEMA, BUNDLER_VERSION, Bundle
from ..schema import Blob
from .blobs import BROTLI, BlobError, Blobs
from .jobs import NO_PROGRESS, JobQueue, Progress, Received, Stage
from .schema import (
    MAX_TEXT_LENGTH,
    IngestJob,
    JobResult,
    Made,
    Versions,
    analysis_key,
    analysis_name,
    bundle_key,
    bundle_name,
    doc_id,
    text_key,
    versions_key,
)

log = logging.getLogger(__name__)

JSON = "application/json"
POLL_SECONDS = 5.0
MAX_BACKOFF_SECONDS = 60.0
# Highest quality: about 1.6 s for a 2,800-word story, paid once per import
BROTLI_QUALITY = 11

Stored = Literal["analysis", "bundle"]
STORE_STAGES: dict[Stored, tuple[Stage, Stage]] = {
    "analysis": ("compressing-analysis", "uploading-analysis"),
    "bundle": ("compressing-bundle", "uploading-bundle"),
}


class JobError(Exception):
    """A job that can't succeed as given; recorded in the status, not retried."""


@dataclass
class Pipeline:
    """What one language needs to ingest a text. Loading it is slow (models), so it's
    built once per worker."""

    lang: str
    analyze: Callable[[str], Blob]
    bundle: Callable[[Blob], Bundle]
    analyzer: str
    """The name analyze() puts in its blobs, known without analysing anything."""
    lexicon_version: str

    def versions(self) -> Versions:
        return {
            "analyzer": self.analyzer,
            "lexicon": self.lexicon_version,
            "analysis": analysis_name(SCHEMA, self.analyzer),
            "bundle": bundle_name(
                BUNDLE_SCHEMA, BUNDLER_VERSION, self.analyzer, self.lexicon_version
            ),
        }


def compressed_json(value: object) -> bytes:
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    return brotli.compress(data, quality=BROTLI_QUALITY)


@contextmanager
def timed(
    progress: Progress, doc: str, words: int | None, stage: Stage, label: str
) -> Generator[None]:
    """Log how long a stage of a job took, failed or not, and tell progress."""
    progress.stage_started(stage)
    start = time.perf_counter()
    try:
        yield
    finally:
        seconds = time.perf_counter() - start
        progress.stage_finished(stage, round(seconds * 1000))
        if words is None:
            log.info("%s: %s took %.2f s", doc, label, seconds)
        else:
            log.info("%s (%d words): %s took %.2f s", doc, words, label, seconds)


class Ingester:
    def __init__(self, blobs: Blobs, pipelines: dict[str, Pipeline]) -> None:
        self._blobs = blobs
        self._pipelines = pipelines

    def publish_versions(self) -> None:
        """Tell the API what's current, so it can queue documents analysed before."""
        for lang, pipeline in self._pipelines.items():
            self._blobs.put(versions_key(lang), json.dumps(pipeline.versions()).encode(), JSON)

    def process(self, job: IngestJob, progress: Progress = NO_PROGRESS) -> JobResult:
        """Raises BlobError when storage fails: that's worth retrying, unlike a failed
        analysis, which would fail the same way again."""
        try:
            made = self._process(job, progress)
        except BlobError:
            raise
        except JobError as error:
            return {"outcome": "failed", "made": None, "error": str(error)}
        except Exception as error:
            log.exception("ingest of %s failed", job["doc"])
            return {"outcome": "failed", "made": None, "error": f"{type(error).__name__}: {error}"}
        return {"outcome": "ready", "made": made, "error": None}

    def _process(self, job: IngestJob, progress: Progress) -> Made:
        doc = job["doc"]
        pipeline = self._pipelines.get(job["lang"])
        if pipeline is None:
            raise JobError(f"no pipeline for language {job['lang']!r}")
        with timed(progress, doc, None, "reading", "reading the text"):
            raw = self._blobs.get(text_key(doc))
            if raw is None:
                raise JobError(f"no text at {text_key(doc)}")
            text = raw.decode("utf-8")
            words = len(text.split())
            progress.text(len(text), words)
            if doc_id(job["lang"], text) != doc:
                raise JobError("text and language don't match the document id")
            if len(text) > MAX_TEXT_LENGTH:
                raise JobError(f"text is longer than {MAX_TEXT_LENGTH} characters")
        versions = pipeline.versions()
        a_key = analysis_key(doc, versions["analysis"])
        b_key = bundle_key(doc, versions["bundle"])
        # Already made (an earlier attempt made them, or the document was queued again):
        # the keys name the versions, so the blobs are current
        if not self._blobs.exists(b_key):
            # A new bundler or lexicon with the same analyser: only the bundle is remade
            stored = self._blobs.get(a_key)
            if stored is not None:
                with timed(progress, doc, words, "loading-analysis", "reading the stored analysis"):
                    analysis = cast(Blob, json.loads(brotli.decompress(stored)))
            else:
                with timed(progress, doc, words, "analysing", "analysis"):
                    analysis = pipeline.analyze(text)
                if analysis["analyzer"] != pipeline.analyzer:
                    # Otherwise the API would keep finding it out of date and queueing it
                    raise JobError(
                        f"analysed as {analysis['analyzer']!r}, but published {pipeline.analyzer!r}"
                    )
            with timed(progress, doc, words, "bundling", "bundling"):
                bundle = pipeline.bundle(analysis)
            if stored is None:
                self._put_compressed(progress, doc, words, "analysis", a_key, analysis)
            self._put_compressed(progress, doc, words, "bundle", b_key, bundle)
        else:
            log.info("%s (%d words): bundle %s already made", doc, words, versions["bundle"])
        return {
            "analyzer": pipeline.analyzer,
            "lexicon": pipeline.lexicon_version,
            "analysis": a_key,
            "bundle": b_key,
        }

    def _put_compressed(
        self,
        progress: Progress,
        doc: str,
        words: int,
        name: Stored,
        key: str,
        value: object,
    ) -> None:
        compressing, uploading = STORE_STAGES[name]
        with timed(progress, doc, words, compressing, f"compressing the {name}"):
            data = compressed_json(value)
        with timed(progress, doc, words, uploading, f"uploading the {name} ({len(data)} bytes)"):
            self._blobs.put(key, data, JSON, BROTLI)

    def run(
        self,
        queue: JobQueue,
        stop: Callable[[], bool] = lambda: False,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        failures = 0
        while not stop():
            try:
                received: Received | None = queue.receive(POLL_SECONDS)
            except Exception:
                # Queue down or a malformed message: keep the worker alive, back off
                failures += 1
                delay = min(MAX_BACKOFF_SECONDS, 2.0**failures)
                log.exception("receiving a job failed; retrying in %.0f s", delay)
                sleep(delay)
                continue
            failures = 0
            if received is None:
                continue
            log.info("ingesting %s (%s)", received.job["doc"], received.job["lang"])
            start = time.perf_counter()
            try:
                result = self.process(received.job, received.progress)
            except BlobError as error:
                # Storage is down: put the job back for later rather than fail the document
                failures += 1
                delay = min(MAX_BACKOFF_SECONDS, 2.0**failures)
                log.exception("storage failed; job back on the queue, waiting %.0f s", delay)
                queue.release(received, f"{type(error).__name__}: {error}")
                sleep(delay)
                continue
            failures = 0
            queue.ack(received, result)
            elapsed = time.perf_counter() - start
            log.info("%s: %s after %.2f s", received.job["doc"], result["outcome"], elapsed)
