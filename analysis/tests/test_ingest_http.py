import json
import re
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import cast

import pytest

from skolia_analysis.ingest.events import Event, HttpEvents, StartedEvent
from skolia_analysis.ingest.http import HttpJobs, JobsState, serve
from skolia_analysis.ingest.jobs import JobResult, Received
from skolia_analysis.ingest.schema import IngestJob, Made

JOB: IngestJob = {"doc": "a" * 64, "lang": "pl", "run": "run-a", "attempt": 1}
MADE: Made = {
    "analyzer": "pl/1",
    "lexicon": "lex/1",
    "analysis": f"doc/{'a' * 64}/analysis/s2-a1.json.br",
    "bundle": f"doc/{'a' * 64}/bundle/b1-v1-a1-l1.json.br",
}
READY: JobResult = {"outcome": "ready", "made": MADE, "error": None}
ISO = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z")
IMAGE = "skolia-ingest:test"


class Recorder:
    def __init__(self) -> None:
        self.events: list[Event] = []

    def send(self, event: Event) -> None:
        self.events.append(event)

    def close(self, timeout: float) -> None:
        pass


def recorded() -> tuple[HttpJobs, Recorder]:
    recorder = Recorder()
    return HttpJobs(recorder, IMAGE), recorder


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
    first, second, third = (
        {"doc": c * 64, "lang": "pl", "run": f"run-{c}", "attempt": 1} for c in "abc"
    )
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


def test_stages_are_recorded_in_order_and_sent_when_finished() -> None:
    jobs, recorder = recorded()
    jobs.add(json.dumps(JOB))
    (waiting,) = jobs.state()["jobs"]
    assert waiting["stage"] is None and waiting["chars"] is None and waiting["stages"] == []
    assert recorder.events == []
    received = started(jobs)
    (running,) = jobs.state()["jobs"]
    assert running["startedAt"] is not None
    assert recorder.events == [
        {
            "kind": "started",
            "id": running["id"],
            "doc": JOB["doc"],
            "lang": "pl",
            "run": "run-a",
            "attempt": 1,
            "image": IMAGE,
            "acceptedAt": running["acceptedAt"],
            "startedAt": running["startedAt"],
        }
    ]
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
    _, finished = recorder.events
    assert finished["kind"] == "finished"
    assert finished == {
        "kind": "finished",
        "id": running["id"],
        "doc": JOB["doc"],
        "lang": "pl",
        "run": "run-a",
        "attempt": 1,
        "image": IMAGE,
        "acceptedAt": running["acceptedAt"],
        "startedAt": running["startedAt"],
        "finishedAt": finished["finishedAt"],
        "outcome": "ready",
        "error": None,
        "made": MADE,
        "chars": 1200,
        "words": 200,
        "stages": running["stages"],
    }
    assert ISO.fullmatch(finished["finishedAt"])


def test_a_failed_job_is_sent_with_its_error() -> None:
    jobs, recorder = recorded()
    jobs.add(json.dumps(JOB))
    jobs.ack(started(jobs), {"outcome": "failed", "made": None, "error": "no text at x"})
    started_event, finished = recorder.events
    assert started_event["kind"] == "started" and finished["kind"] == "finished"
    assert finished["id"] == started_event["id"]
    assert (finished["outcome"], finished["error"]) == ("failed", "no text at x")


def test_a_released_job_is_sent_as_retried_and_starts_again_under_a_new_id() -> None:
    jobs, recorder = recorded()
    jobs.add(json.dumps(JOB))
    received = started(jobs)
    received.progress.stage_started("reading")
    received.progress.stage_finished("reading", 5)
    (attempt,) = jobs.state()["jobs"]
    jobs.release(received, "BlobError: connection refused")
    (again,) = jobs.state()["jobs"]
    assert again["id"] != attempt["id"]
    assert again["acceptedAt"] == attempt["acceptedAt"]
    assert again["startedAt"] is None and again["stages"] == []
    jobs.ack(started(jobs), READY)
    first_start, retried, second_start, ready = recorder.events
    assert first_start["kind"] == "started" and first_start["id"] == attempt["id"]
    assert retried["kind"] == "finished" and retried["id"] == attempt["id"]
    assert retried["outcome"] == "retried"
    assert retried["error"] == "BlobError: connection refused"
    assert retried["stages"] == [{"stage": "reading", "ms": 5}]
    assert second_start["kind"] == "started" and second_start["id"] == again["id"]
    assert second_start["acceptedAt"] == attempt["acceptedAt"]
    assert ready["kind"] == "finished" and ready["id"] == again["id"]
    assert ready["outcome"] == "ready"


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


def test_jobs_are_posted_and_busy_reported(server: tuple[HttpJobs, int]) -> None:
    jobs, port = server
    assert request(port, "GET", "/busy") == (200, {"busy": False})
    assert request(port, "POST", "/jobs", json.dumps(JOB).encode()) == (202, {"accepted": True})
    assert request(port, "GET", "/busy") == (200, {"busy": True})
    status, body = request(port, "GET", "/jobs")
    assert status == 200
    state = cast(JobsState, body)
    assert (state["loading"], state["running"], state["waiting"]) == (True, [], [JOB["doc"]])
    assert state == jobs.state()
    assert started(jobs).job == JOB


def test_a_malformed_job_is_refused(server: tuple[HttpJobs, int]) -> None:
    jobs, port = server
    status, _ = request(port, "POST", "/jobs", b'{"doc": 1}')
    assert status == 400
    status, _ = request(port, "POST", "/jobs", b"not json")
    assert status == 400
    assert not jobs.busy()


class EventServer:
    """Stands in for the ingest Worker: answers each POST with the next of statuses (then 202),
    and keeps what it accepted."""

    def __init__(self, statuses: list[int]) -> None:
        self.statuses = statuses
        self.attempts: list[str] = []
        self.accepted: list[str] = []
        events = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                event_id = cast(str, body["id"])
                events.attempts.append(event_id)
                status = events.statuses.pop(0) if events.statuses else 202
                if status == 202:
                    events.accepted.append(event_id)
                self.send_response(status)
                self.send_header("content-length", "0")
                self.end_headers()

            def log_message(self, format: str, *args: object) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/"


@pytest.fixture
def event_server() -> Iterator[Callable[[list[int]], EventServer]]:
    servers: list[EventServer] = []

    def start(statuses: list[int]) -> EventServer:
        servers.append(EventServer(statuses))
        return servers[-1]

    yield start
    for each in servers:
        each.httpd.shutdown()


def event(event_id: str) -> StartedEvent:
    return {
        "kind": "started",
        "id": event_id,
        "doc": JOB["doc"],
        "lang": "pl",
        "run": "run-a",
        "attempt": 1,
        "image": IMAGE,
        "acceptedAt": "2026-11-17T10:04:05.123Z",
        "startedAt": "2026-11-17T10:04:06.456Z",
    }


def until(condition: Callable[[], bool], seconds: float = 5.0) -> None:
    deadline = time.monotonic() + seconds
    while not condition():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)


def test_events_are_posted_in_order(
    event_server: Callable[[list[int]], EventServer],
) -> None:
    api = event_server([])
    sender = HttpEvents(api.url)
    sender.send(event("one"))
    sender.send(event("two"))
    sender.close(5.0)
    assert api.accepted == ["one", "two"]


def test_server_errors_and_rate_limits_are_retried(
    event_server: Callable[[list[int]], EventServer],
) -> None:
    api = event_server([503, 500, 429])
    sender = HttpEvents(api.url, first_backoff=0.01)
    sender.send(event("one"))
    sender.send(event("two"))
    until(lambda: len(api.accepted) == 2)
    sender.close(1.0)
    assert api.attempts == ["one", "one", "one", "one", "two"]
    assert api.accepted == ["one", "two"]


def test_an_event_is_dropped_after_its_attempts(
    event_server: Callable[[list[int]], EventServer],
) -> None:
    api = event_server([503, 503, 503])
    sender = HttpEvents(api.url, first_backoff=0.01, max_attempts=3)
    sender.send(event("stuck"))
    sender.send(event("next"))
    until(lambda: api.accepted == ["next"])
    sender.close(1.0)
    assert api.attempts == ["stuck", "stuck", "stuck", "next"]


def test_a_refused_event_is_dropped(event_server: Callable[[list[int]], EventServer]) -> None:
    api = event_server([400])
    sender = HttpEvents(api.url, first_backoff=0.01)
    sender.send(event("bad"))
    sender.send(event("good"))
    until(lambda: api.accepted == ["good"])
    sender.close(1.0)
    assert api.attempts == ["bad", "good"]


def test_past_the_cap_the_oldest_events_are_dropped(
    event_server: Callable[[list[int]], EventServer],
) -> None:
    api = event_server([503] * 1000)
    sender = HttpEvents(api.url, max_queued=2, first_backoff=0.3)
    sender.send(event("one"))
    until(lambda: bool(api.attempts))
    sender.send(event("two"))
    sender.send(event("three"))
    api.statuses.clear()
    until(lambda: len(api.accepted) == 2)
    sender.close(1.0)
    assert api.accepted == ["two", "three"]
    assert set(api.attempts) == {"one", "two", "three"}


def test_closing_gives_up_after_its_timeout(
    event_server: Callable[[list[int]], EventServer],
) -> None:
    api = event_server([503] * 1000)
    sender = HttpEvents(api.url, first_backoff=10.0)
    sender.send(event("one"))
    until(lambda: bool(api.attempts))
    start = time.monotonic()
    sender.close(0.5)
    assert time.monotonic() - start < 1.0
    assert api.accepted == []


def test_closing_tries_a_waiting_event_once_more(
    event_server: Callable[[list[int]], EventServer],
) -> None:
    api = event_server([503])
    sender = HttpEvents(api.url, first_backoff=10.0)
    sender.send(event("one"))
    until(lambda: bool(api.attempts))
    sender.close(2.0)
    assert api.accepted == ["one"]
