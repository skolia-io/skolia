import json
from collections.abc import Iterable
from pathlib import Path

import brotli
import pytest
from structlog.testing import capture_logs

from skolia_analysis.blob import SCHEMA
from skolia_analysis.ingest.blobs import BlobError, DirBlobs
from skolia_analysis.ingest.jobs import InvalidJob, MemoryQueue, Received, Stage, parse_job
from skolia_analysis.ingest.schema import (
    MAX_TEXT_LENGTH,
    IngestJob,
    ReadyAnalysis,
    doc_id,
    status_key,
    text_key,
    versions_key,
)
from skolia_analysis.ingest.worker import Ingester, versions
from skolia_analysis.parsed import ParsedSentence
from skolia_analysis.plugin import Analyzer
from skolia_analysis.schema import Blob

TEXT = "Idę do psa."


class FakeAnalyzer:
    name = "test/1"

    def __init__(self) -> None:
        self.analysed: list[str] = []

    def __call__(self, text: str) -> Blob:
        self.analysed.append(text)
        return {"schema": 2, "analyzer": self.name, "lang": "pl", "hash": "", "sentences": []}

    def assemble(self, text: str, parsed: Iterable[ParsedSentence]) -> Blob:
        return self(text)


def analyzers() -> dict[str, Analyzer]:
    return {"pl": FakeAnalyzer()}


def job(doc: str, lang: str = "pl") -> IngestJob:
    return {"doc": doc, "lang": lang}


def run_to_ready(
    blobs: DirBlobs, doc: str, analyzers: dict[str, Analyzer], lang: str = "pl"
) -> ReadyAnalysis:
    result = Ingester(blobs, analyzers).process(job(doc, lang))
    assert result["analysis"] is not None, result
    return result["analysis"]


def test_job_writes_analysis_but_no_status(tmp_path: Path) -> None:
    blobs = DirBlobs(tmp_path)
    doc = doc_id("pl", TEXT)
    blobs.put(text_key(doc), TEXT.encode(), "text/plain")
    queue = MemoryQueue()
    queue.send(job(doc))
    Ingester(blobs, analyzers()).run(queue, stop=lambda: not queue.pending)
    assert queue.acked == [job(doc)]
    # The run that asked for it writes the status (ingest/src/workflow.ts)
    assert blobs.get(status_key(doc)) is None
    ready = run_to_ready(blobs, doc, analyzers())
    analysis = blobs.get(ready["analysis"])
    assert analysis is not None
    assert json.loads(brotli.decompress(analysis))["analyzer"] == "test/1"


def test_each_stage_of_a_job_logs_its_time(tmp_path: Path) -> None:
    blobs = DirBlobs(tmp_path)
    doc = doc_id("pl", TEXT)
    blobs.put(text_key(doc), TEXT.encode(), "text/plain")
    queue = MemoryQueue()
    queue.send(job(doc))
    with capture_logs() as events:
        Ingester(blobs, analyzers()).run(queue, stop=lambda: not queue.pending)

    assert events[0]["event"] == "ingest started"
    assert events[0]["lang"] == "pl"
    assert all(event["doc"] == doc for event in events)
    stages = events[1:-1]
    assert all(event["event"] == "ingest stage finished" for event in stages)
    assert [event["stage"] for event in stages] == [
        "reading",
        "analysing",
        "compressing-analysis",
        "uploading-analysis",
    ]
    assert [event["words"] for event in stages] == [None, 3, 3, 3]
    assert isinstance(stages[3]["bytes"], int) and stages[3]["bytes"] > 0
    assert events[-1]["event"] == "ingest finished"
    assert events[-1]["outcome"] == "ready"
    for event in events[1:]:
        assert isinstance(event["ms"], int) and event["ms"] >= 0


class Recorded:
    def __init__(self) -> None:
        self.events: list[tuple[str, Stage]] = []
        self.ms: list[int] = []
        self.counts: tuple[int, int] | None = None

    def text(self, chars: int, words: int) -> None:
        self.counts = (chars, words)

    def stage_started(self, stage: Stage) -> None:
        self.events.append(("started", stage))

    def stage_finished(self, stage: Stage, ms: int) -> None:
        self.events.append(("finished", stage))
        self.ms.append(ms)


def test_each_stage_is_reported_to_the_jobs_progress(tmp_path: Path) -> None:
    blobs = DirBlobs(tmp_path)
    doc = doc_id("pl", TEXT)
    blobs.put(text_key(doc), TEXT.encode(), "text/plain")
    progress = Recorded()
    Ingester(blobs, analyzers()).process(job(doc), progress)
    stages: list[Stage] = [
        "reading",
        "analysing",
        "compressing-analysis",
        "uploading-analysis",
    ]
    assert progress.events == [
        event for stage in stages for event in (("started", stage), ("finished", stage))
    ]
    assert all(ms >= 0 for ms in progress.ms)
    assert progress.counts == (len(TEXT), 3)


def test_all_of_a_document_is_under_one_prefix(tmp_path: Path) -> None:
    blobs = DirBlobs(tmp_path)
    doc = doc_id("pl", TEXT)
    blobs.put(text_key(doc), TEXT.encode(), "text/plain")
    ready = run_to_ready(blobs, doc, analyzers())
    keys = [text_key(doc), status_key(doc), ready["analysis"]]
    assert all(key.startswith(f"doc/{doc}/") for key in keys), keys


def test_missing_text_and_unknown_language_fail_without_retry(tmp_path: Path) -> None:
    blobs = DirBlobs(tmp_path)
    ingester = Ingester(blobs, analyzers())
    assert ingester.process(job("abc"))["outcome"] == "failed"
    doc = doc_id("pl", TEXT)
    blobs.put(text_key(doc), TEXT.encode(), "text/plain")
    failed = ingester.process(job(doc, "xx"))
    assert failed["outcome"] == "failed"
    assert "xx" in (failed["error"] or "")


def test_text_over_the_limit_fails_before_analysis(tmp_path: Path) -> None:
    blobs = DirBlobs(tmp_path)
    text = "a" * (MAX_TEXT_LENGTH + 1)
    doc = doc_id("pl", text)
    blobs.put(text_key(doc), text.encode(), "text/plain")
    analyzer = FakeAnalyzer()
    failed = Ingester(blobs, {"pl": analyzer}).process(job(doc))
    assert failed["outcome"] == "failed"
    assert analyzer.analysed == []


def test_text_must_match_its_id(tmp_path: Path) -> None:
    blobs = DirBlobs(tmp_path)
    blobs.put(text_key("abc"), TEXT.encode(), "text/plain")
    assert Ingester(blobs, analyzers()).process(job("abc"))["outcome"] == "failed"


def test_versions_are_published_for_the_api(tmp_path: Path) -> None:
    blobs = DirBlobs(tmp_path)
    Ingester(blobs, analyzers()).publish_versions()
    raw = blobs.get(versions_key("pl"))
    assert raw is not None
    versions = json.loads(raw)
    assert versions["analyzer"] == "test/1"
    assert versions["analysis"].startswith(f"s{SCHEMA}-a")


def test_what_a_job_made_has_the_published_names(tmp_path: Path) -> None:
    blobs = DirBlobs(tmp_path)
    doc = doc_id("pl", TEXT)
    blobs.put(text_key(doc), TEXT.encode(), "text/plain")
    analyzer = FakeAnalyzer()
    ready = run_to_ready(blobs, doc, {"pl": analyzer})
    assert ready["analysis"] == f"doc/{doc}/analysis/{versions(analyzer)['analysis']}.json.br"


class FailingBlobs(DirBlobs):
    """Storage that goes down after the text has been read, like an S3 outage."""

    def put(self, key: str, data: bytes, content_type: str, encoding: str | None = None) -> None:
        if not key.endswith("text.txt"):
            raise BlobError(f"put {key}: connection refused")
        super().put(key, data, content_type, encoding)


def test_a_storage_failure_puts_the_job_back_instead_of_failing_it(tmp_path: Path) -> None:
    blobs = FailingBlobs(tmp_path)
    doc = doc_id("pl", TEXT)
    blobs.put(text_key(doc), TEXT.encode(), "text/plain")
    queue = MemoryQueue()
    queue.send(job(doc))
    slept: list[float] = []
    Ingester(blobs, analyzers()).run(queue, stop=lambda: bool(slept), sleep=slept.append)
    assert queue.released == [job(doc)]
    assert queue.acked == []
    assert len(queue.pending) == 1
    assert blobs.get(status_key(doc)) is None


def test_a_job_already_done_is_not_analysed_again(tmp_path: Path) -> None:
    blobs = DirBlobs(tmp_path)
    doc = doc_id("pl", TEXT)
    blobs.put(text_key(doc), TEXT.encode(), "text/plain")
    analyzer = FakeAnalyzer()
    ingester = Ingester(blobs, {"pl": analyzer})
    ingester.process(job(doc))
    assert ingester.process(job(doc))["outcome"] == "ready"
    assert len(analyzer.analysed) == 1


class FlakyQueue(MemoryQueue):
    """Fails the first receive, like a queue that's briefly unreachable."""

    def __init__(self) -> None:
        super().__init__()
        self.failed = False

    def receive(self, timeout: float) -> Received | None:
        if not self.failed:
            self.failed = True
            raise ConnectionError("queue went away")
        return super().receive(timeout)


def test_worker_survives_a_failing_queue(tmp_path: Path) -> None:
    blobs = DirBlobs(tmp_path)
    doc = doc_id("pl", TEXT)
    blobs.put(text_key(doc), TEXT.encode(), "text/plain")
    queue = FlakyQueue()
    queue.send(job(doc))
    slept: list[float] = []
    Ingester(blobs, analyzers()).run(queue, stop=lambda: not queue.pending, sleep=slept.append)
    assert slept == [2.0]
    assert queue.acked == [job(doc)]


def test_parse_job_rejects_bad_messages() -> None:
    assert parse_job('{"doc": "a", "lang": "pl"}') == {"doc": "a", "lang": "pl"}
    with pytest.raises(InvalidJob):
        parse_job('{"doc": 1, "lang": "pl"}')
    with pytest.raises(InvalidJob):
        parse_job("[]")


def test_doc_id_matches_the_api() -> None:
    # The same value is asserted in api/src/app.test.ts against docId in shared/keys.ts
    expected = "d8fc9f68cd4e27140cbfe3d63851f0d2af4026ce726f9e9cdcb8682a537c71a7"
    assert doc_id("pl", "Idę do domu.") == expected
    assert doc_id("en", "Idę do domu.") != expected
