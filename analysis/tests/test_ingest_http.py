import json
import re
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from typing import cast

import pytest

from skolia_analysis.ingest.http import HttpJobs, JobsState, serve
from skolia_analysis.ingest.jobs import Received
from skolia_analysis.ingest.schema import IngestJob, JobAnswer, JobResult, ReadyAnalysis

JOB: IngestJob = {"doc": "a" * 64, "lang": "pl"}
ANALYSIS: ReadyAnalysis = {
    "analyzer": "pl/1",
    "analysis": f"doc/{'a' * 64}/analysis/s2-a1.json.br",
}
READY: JobResult = {"outcome": "ready", "analysis": ANALYSIS, "error": None}
ISO = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z")
IMAGE = "skolia-ingest:test"


def started(jobs: HttpJobs) -> Received:
    received = jobs.receive(0.1)
    assert received is not None
    return received


def test_busy_while_a_job_waits_or_runs() -> None:
    jobs = HttpJobs()
    assert not jobs.busy()
    jobs.add(json.dumps(JOB))
    assert jobs.busy()
    received = started(jobs)
    assert received.job == JOB
    assert jobs.busy()
    jobs.ack(received, READY)
    assert not jobs.busy()
    assert jobs.receive(0.01) is None


def test_a_released_job_comes_back() -> None:
    jobs = HttpJobs()
    jobs.add(json.dumps(JOB))
    jobs.release(started(jobs), "BlobError: connection refused")
    assert jobs.busy()
    assert started(jobs).job == JOB


def test_state_lists_running_then_waiting_documents_in_order() -> None:
    jobs = HttpJobs()
    first, second, third = ({"doc": c * 64, "lang": "pl"} for c in "abc")
    for job in (first, second, third):
        jobs.add(json.dumps(job))
    state = jobs.state()
    assert (state["loading"], state["running"], state["waiting"]) == (
        True,
        [],
        ["a" * 64, "b" * 64, "c" * 64],
    )
    assert ISO.fullmatch(state["startedAt"])
    jobs.loaded()
    received = started(jobs)
    state = jobs.state()
    assert (state["loading"], state["running"], state["waiting"]) == (
        False,
        ["a" * 64],
        ["b" * 64, "c" * 64],
    )
    assert [j["doc"] for j in state["jobs"]] == ["a" * 64, "b" * 64, "c" * 64]
    assert [j["startedAt"] is not None for j in state["jobs"]] == [True, False, False]
    assert len({j["id"] for j in state["jobs"]}) == 3
    jobs.ack(received, READY)
    state = jobs.state()
    assert (state["running"], state["waiting"]) == ([], ["b" * 64, "c" * 64])
    assert [j["doc"] for j in state["jobs"]] == ["b" * 64, "c" * 64]


def test_stages_are_recorded_in_order_and_answered_with_the_attempt() -> None:
    jobs = HttpJobs(IMAGE)
    answer = jobs.add(json.dumps(JOB))
    (waiting,) = jobs.state()["jobs"]
    assert waiting["stage"] is None and waiting["chars"] is None and waiting["stages"] == []
    received = started(jobs)
    (running,) = jobs.state()["jobs"]
    assert running["startedAt"] is not None
    received.progress.stage_started("reading")
    received.progress.text(1200, 200)
    (running,) = jobs.state()["jobs"]
    assert running["stage"] == "reading"
    assert running["stageStartedAt"] is not None and ISO.fullmatch(running["stageStartedAt"])
    assert (running["chars"], running["words"]) == (1200, 200)
    received.progress.stage_finished("reading", 12)
    received.progress.stage_started("analysing")
    received.progress.stage_finished("analysing", 3400)
    (running,) = jobs.state()["jobs"]
    assert running["stage"] is None and running["stageStartedAt"] is None
    assert running["stages"] == [
        {"stage": "reading", "ms": 12},
        {"stage": "analysing", "ms": 3400},
    ]
    jobs.ack(received, READY)
    assert jobs.state()["jobs"] == []
    answered = answer.wait()
    assert answered["result"] == READY
    (attempt,) = answered["attempts"]
    assert attempt == {
        "id": running["id"],
        "image": IMAGE,
        "acceptedAt": running["acceptedAt"],
        "startedAt": running["startedAt"],
        "finishedAt": attempt["finishedAt"],
        "outcome": "ready",
        "error": None,
        "chars": 1200,
        "words": 200,
        "stages": running["stages"],
    }
    assert ISO.fullmatch(attempt["finishedAt"])


def test_a_failed_job_is_answered_with_its_error() -> None:
    jobs = HttpJobs(IMAGE)
    answer = jobs.add(json.dumps(JOB))
    failed: JobResult = {"outcome": "failed", "analysis": None, "error": "no text at x"}
    jobs.ack(started(jobs), failed)
    answered = answer.wait()
    assert answered["result"] == failed
    (attempt,) = answered["attempts"]
    assert (attempt["outcome"], attempt["error"]) == ("failed", "no text at x")


def test_a_released_job_is_attempted_again_under_a_new_id() -> None:
    jobs = HttpJobs(IMAGE)
    answer = jobs.add(json.dumps(JOB))
    received = started(jobs)
    received.progress.stage_started("reading")
    received.progress.stage_finished("reading", 5)
    (first,) = jobs.state()["jobs"]
    jobs.release(received, "BlobError: connection refused")
    (again,) = jobs.state()["jobs"]
    assert again["id"] != first["id"]
    assert again["acceptedAt"] == first["acceptedAt"]
    assert again["startedAt"] is None and again["stages"] == []
    jobs.ack(started(jobs), READY)
    retried, ready = answer.wait()["attempts"]
    assert (retried["id"], retried["outcome"]) == (first["id"], "retried")
    assert retried["error"] == "BlobError: connection refused"
    assert retried["stages"] == [{"stage": "reading", "ms": 5}]
    assert (ready["id"], ready["outcome"], ready["acceptedAt"]) == (
        again["id"],
        "ready",
        first["acceptedAt"],
    )


def request(port: int, method: str, path: str, body: bytes | None = None) -> tuple[int, object]:
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=body, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


@pytest.fixture
def server() -> Iterator[tuple[HttpJobs, int]]:
    jobs = HttpJobs()
    httpd = serve(jobs, "127.0.0.1", 0)
    yield jobs, httpd.server_address[1]
    httpd.shutdown()


def posted(port: int, job: IngestJob) -> Callable[[], tuple[int, object]]:
    """POSTs the job from another thread, since the answer waits for it to finish; returns
    what gets that answer."""
    answers: list[tuple[int, object]] = []
    thread = threading.Thread(
        target=lambda: answers.append(request(port, "POST", "/jobs", json.dumps(job).encode()))
    )
    thread.start()

    def answer() -> tuple[int, object]:
        thread.join(5)
        (got,) = answers
        return got

    return answer


def test_a_posted_job_is_answered_with_its_result_once_it_finishes(
    server: tuple[HttpJobs, int],
) -> None:
    jobs, port = server
    assert request(port, "GET", "/busy") == (200, {"busy": False})
    answer = posted(port, JOB)
    until(jobs.busy)
    assert request(port, "GET", "/busy") == (200, {"busy": True})
    status, body = request(port, "GET", "/jobs")
    assert status == 200
    state = cast(JobsState, body)
    assert (state["loading"], state["running"], state["waiting"]) == (True, [], [JOB["doc"]])
    assert state == jobs.state()
    received = started(jobs)
    assert received.job == JOB
    jobs.ack(received, READY)
    status, body = answer()
    assert status == 200
    answered = cast(JobAnswer, body)
    assert answered["result"] == READY
    assert [attempt["outcome"] for attempt in answered["attempts"]] == ["ready"]


def test_a_released_job_is_answered_when_it_finishes_on_a_later_attempt(
    server: tuple[HttpJobs, int],
) -> None:
    jobs, port = server
    answer = posted(port, JOB)
    until(jobs.busy)
    jobs.release(started(jobs), "BlobError: connection refused")
    failed: JobResult = {"outcome": "failed", "analysis": None, "error": "no text at x"}
    jobs.ack(started(jobs), failed)
    status, body = answer()
    assert status == 200
    answered = cast(JobAnswer, body)
    assert answered["result"] == failed
    assert [attempt["outcome"] for attempt in answered["attempts"]] == ["retried", "failed"]


def test_a_malformed_job_is_refused(server: tuple[HttpJobs, int]) -> None:
    jobs, port = server
    status, _ = request(port, "POST", "/jobs", b'{"doc": 1}')
    assert status == 400
    status, _ = request(port, "POST", "/jobs", b"not json")
    assert status == 400
    assert not jobs.busy()


def until(condition: Callable[[], bool], seconds: float = 5.0) -> None:
    deadline = time.monotonic() + seconds
    while not condition():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)
