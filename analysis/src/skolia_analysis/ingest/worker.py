"""Process import jobs: text blob -> analysis blob. The run that asked for a job
keeps the document's status (ingest/src/workflow.ts), from the job's result."""

import json
import time
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager

import brotli
import structlog

from ..blob import SCHEMA
from ..plugin import Analyzer
from .blobs import BROTLI, BlobError, Blobs
from .jobs import NO_PROGRESS, JobQueue, Progress, Received, Stage
from .schema import (
    MAX_TEXT_LENGTH,
    IngestFailure,
    IngestJob,
    JobResult,
    ReadyAnalysis,
    Versions,
    analysis_key,
    analysis_name,
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


class JobError(Exception):
    """A job that can't succeed as given; recorded in the status, not retried."""

    failure: IngestFailure

    def __init__(self, failure: IngestFailure) -> None:
        super().__init__(failure["kind"])
        self.failure = failure


def versions(analyzer: Analyzer) -> Versions:
    return {"analyzer": analyzer.name, "analysis": analysis_name(SCHEMA, analyzer.name)}


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
    def __init__(self, blobs: Blobs, analyzers: Mapping[str, Analyzer]) -> None:
        """analyzers by language. Loading one is slow (models), so they're built once per
        worker."""
        self._blobs = blobs
        self._analyzers = analyzers

    def publish_versions(self) -> None:
        """Tell the API what's current, so it can queue documents analysed before."""
        for lang, analyzer in self._analyzers.items():
            self._blobs.put(versions_key(lang), json.dumps(versions(analyzer)).encode(), JSON)

    def process(self, job: IngestJob, progress: Progress = NO_PROGRESS) -> JobResult:
        """Raises BlobError when storage fails: that's worth retrying, unlike a failed
        analysis, which would fail the same way again."""
        try:
            analysis = self._process(job, progress)
        except BlobError:
            raise
        except JobError as error:
            log.warning(
                "ingest rejected job", doc=job["doc"], lang=job["lang"], failure=error.failure
            )
            return {"outcome": "failed", "analysis": None, "error": error.failure}
        except Exception:
            log.exception("ingest failed", doc=job["doc"])
            return {
                "outcome": "failed",
                "analysis": None,
                "error": {"kind": "analysis-failed"},
            }
        return {"outcome": "ready", "analysis": analysis, "error": None}

    def _process(self, job: IngestJob, progress: Progress) -> ReadyAnalysis:
        doc = job["doc"]
        analyzer = self._analyzers.get(job["lang"])
        if analyzer is None:
            raise JobError({"kind": "unsupported-language", "lang": job["lang"]})
        with timed(progress, doc, None, "reading"):
            raw = self._blobs.get(text_key(doc))
            if raw is None:
                raise JobError({"kind": "missing-text"})
            text = raw.decode("utf-8")
            words = len(text.split())
            progress.text(len(text), words)
            if doc_id(job["lang"], text) != doc:
                raise JobError({"kind": "document-mismatch"})
            if len(text) > MAX_TEXT_LENGTH:
                raise JobError(
                    {"kind": "text-too-long", "chars": len(text), "limit": MAX_TEXT_LENGTH}
                )
        names = versions(analyzer)
        a_key = analysis_key(doc, names["analysis"])
        if not self._blobs.exists(a_key):
            with timed(progress, doc, words, "analysing"):
                analysis = analyzer(text)
            with timed(progress, doc, words, "compressing-analysis"):
                data = compressed_json(analysis)
            with timed(progress, doc, words, "uploading-analysis", size_bytes=len(data)):
                self._blobs.put(a_key, data, JSON, BROTLI)
        else:
            log.info("analysis already exists", doc=doc, words=words, analysis=names["analysis"])
        return {"analyzer": analyzer.name, "analysis": a_key}

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
            except BlobError:
                # Storage is down: put the job back for later rather than fail the document
                failures += 1
                delay = min(MAX_BACKOFF_SECONDS, 2.0**failures)
                job_log.exception("storage failed", retry_ms=round(delay * 1000))
                queue.release(received, {"kind": "storage-unavailable"})
                sleep(delay)
                continue
            failures = 0
            queue.ack(received, result)
            ms = round((time.perf_counter() - start) * 1000)
            job_log.info("ingest finished", outcome=result["outcome"], ms=ms)
