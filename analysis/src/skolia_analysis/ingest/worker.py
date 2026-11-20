"""Process import jobs: text blob -> analysis + bundle blobs. The run that asked for a job
keeps the document's status (ingest/src/workflow.ts), from the job's result."""

import json
import time
from collections.abc import Callable, Generator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Literal, cast

import brotli
import structlog

from ..blob import SCHEMA
from ..lexicon.schema import BUNDLE_SCHEMA, BUNDLER_VERSION, Bundle
from ..schema import Blob
from .blobs import BROTLI, BlobError, Blobs
from .jobs import NO_PROGRESS, JobQueue, Progress, Received, Stage
from .schema import (
    MAX_TEXT_LENGTH,
    IngestJob,
    JobResult,
    ReadyAnalysis,
    Versions,
    analysis_key,
    analysis_name,
    bundle_key,
    bundle_name,
    doc_id,
    text_key,
    versions_key,
)

log = structlog.get_logger(module=__name__)

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
    progress: Progress, doc: str, words: int | None, stage: Stage, *, size_bytes: int | None = None
) -> Generator[None]:
    """Log how long a stage of a job took, failed or not, and tell progress."""
    progress.stage_started(stage)
    start = time.perf_counter()
    try:
        yield
    finally:
        ms = round((time.perf_counter() - start) * 1000)
        progress.stage_finished(stage, ms)
        log.info(
            "ingest stage finished", doc=doc, stage=stage, words=words, ms=ms, bytes=size_bytes
        )


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
            analysis = self._process(job, progress)
        except BlobError:
            raise
        except JobError as error:
            return {"outcome": "failed", "analysis": None, "error": str(error)}
        except Exception as error:
            log.exception("ingest failed", doc=job["doc"])
            return {
                "outcome": "failed",
                "analysis": None,
                "error": f"{type(error).__name__}: {error}",
            }
        return {"outcome": "ready", "analysis": analysis, "error": None}

    def _process(self, job: IngestJob, progress: Progress) -> ReadyAnalysis:
        doc = job["doc"]
        pipeline = self._pipelines.get(job["lang"])
        if pipeline is None:
            raise JobError(f"no pipeline for language {job['lang']!r}")
        with timed(progress, doc, None, "reading"):
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
                with timed(progress, doc, words, "loading-analysis"):
                    analysis = cast(Blob, json.loads(brotli.decompress(stored)))
            else:
                with timed(progress, doc, words, "analysing"):
                    analysis = pipeline.analyze(text)
                if analysis["analyzer"] != pipeline.analyzer:
                    # Otherwise the API would keep finding it out of date and queueing it
                    raise JobError(
                        f"analysed as {analysis['analyzer']!r}, but published {pipeline.analyzer!r}"
                    )
            with timed(progress, doc, words, "bundling"):
                bundle = pipeline.bundle(analysis)
            if stored is None:
                self._put_compressed(progress, doc, words, "analysis", a_key, analysis)
            self._put_compressed(progress, doc, words, "bundle", b_key, bundle)
        else:
            log.info("bundle already exists", doc=doc, words=words, bundle=versions["bundle"])
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
        with timed(progress, doc, words, compressing):
            data = compressed_json(value)
        with timed(progress, doc, words, uploading, size_bytes=len(data)):
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
                log.exception("receiving a job failed", retry_ms=round(delay * 1000))
                sleep(delay)
                continue
            failures = 0
            if received is None:
                continue
            job_log = log.bind(doc=received.job["doc"], lang=received.job["lang"])
            job_log.info("ingest started")
            start = time.perf_counter()
            try:
                result = self.process(received.job, received.progress)
            except BlobError as error:
                # Storage is down: put the job back for later rather than fail the document
                failures += 1
                delay = min(MAX_BACKOFF_SECONDS, 2.0**failures)
                job_log.exception("storage failed", retry_ms=round(delay * 1000))
                queue.release(received, f"{type(error).__name__}: {error}")
                sleep(delay)
                continue
            failures = 0
            queue.ack(received, result)
            ms = round((time.perf_counter() - start) * 1000)
            job_log.info("ingest finished", outcome=result["outcome"], ms=ms)
