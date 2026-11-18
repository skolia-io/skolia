"""Jobs over HTTP, for the Cloudflare container: a run of the ingest Worker's
IngestWorkflow POSTs each here and waits for the answer. Jobs live in memory, so a
container stopped mid-job loses them, and with them the request, which the run then
sends again.

  POST /jobs   an IngestJob as JSON -> 200 JobAnswer, once the job has finished: its
               result, and its attempts for the ingest history
  GET  /busy   {"busy": bool}: whether a job is waiting or running, so the container
               isn't put to sleep mid-analysis
  GET  /jobs   JobsState: whether the pipelines are still loading, and the jobs running
               and waiting in the order they'll run, with their stages so far
"""

from __future__ import annotations

import json
import logging
import threading
import uuid
from collections import deque
from datetime import UTC, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Literal, TypedDict, override

from .jobs import InvalidJob, Received, parse_job
from .schema import IngestJob, JobAnswer, JobAttempt, JobResult, Stage, StageTime

log = logging.getLogger(__name__)

MAX_BODY_BYTES = 4096
# An attempt's error is cut to this many code points: at most 2 UTF-16 code units each,
# within MAX_INGEST_ERROR (shared/schemas.ts)
MAX_ERROR = 1000


class ContainerJob(TypedDict):
    id: str
    doc: str
    lang: str
    acceptedAt: str
    startedAt: str | None
    stage: Stage | None
    stageStartedAt: str | None
    chars: int | None
    words: int | None
    stages: list[StageTime]


class JobsState(TypedDict):
    loading: bool
    running: list[str]
    waiting: list[str]
    startedAt: str
    jobs: list[ContainerJob]


def iso_now() -> str:
    """Like SQLite's strftime('%Y-%m-%dT%H:%M:%fZ')."""
    moment = datetime.now(UTC)
    return f"{moment:%Y-%m-%dT%H:%M:%S}.{moment.microsecond // 1000:03d}Z"


class Answer:
    """What POST /jobs waits for: the job's result, once its last attempt has finished, and
    each of its attempts."""

    def __init__(self) -> None:
        self._done = threading.Event()
        self._attempts: list[JobAttempt] = []
        self._result: JobResult | None = None

    def attempted(self, attempt: JobAttempt) -> None:
        self._attempts.append(attempt)

    def give(self, result: JobResult) -> None:
        self._result = result
        self._done.set()

    def wait(self) -> JobAnswer:
        self._done.wait()
        assert self._result is not None
        return {"result": self._result, "attempts": list(self._attempts)}


class _Job:
    """One attempt at a job, from POST /jobs (or its release) until it's finished. It's
    the Progress of its Received, called from the worker thread."""

    def __init__(
        self,
        lock: threading.Condition,
        job: IngestJob,
        raw: str,
        accepted_at: str,
        answer: Answer,
    ) -> None:
        self._lock = lock
        self.answer = answer
        self.id = uuid.uuid4().hex
        self.accepted_at = accepted_at
        self.received = Received(job, raw, self)
        self.started_at: str | None = None
        self._stage: Stage | None = None
        self._stage_started_at: str | None = None
        self._chars: int | None = None
        self._words: int | None = None
        self._stages: list[StageTime] = []

    def text(self, chars: int, words: int) -> None:
        with self._lock:
            self._chars, self._words = chars, words

    def stage_started(self, stage: Stage) -> None:
        with self._lock:
            self._stage, self._stage_started_at = stage, iso_now()

    def stage_finished(self, stage: Stage, ms: int) -> None:
        with self._lock:
            self._stages.append({"stage": stage, "ms": ms})
            self._stage, self._stage_started_at = None, None

    def view(self) -> ContainerJob:
        job = self.received.job
        return {
            "id": self.id,
            "doc": job["doc"],
            "lang": job["lang"],
            "acceptedAt": self.accepted_at,
            "startedAt": self.started_at,
            "stage": self._stage,
            "stageStartedAt": self._stage_started_at,
            "chars": self._chars,
            "words": self._words,
            "stages": list(self._stages),
        }

    def attempt(
        self, image: str, outcome: Literal["ready", "failed", "retried"], error: str | None
    ) -> JobAttempt:
        assert self.started_at is not None, "finished before it was received"
        return {
            "id": self.id,
            "image": image,
            "acceptedAt": self.accepted_at,
            "startedAt": self.started_at,
            "finishedAt": iso_now(),
            "outcome": outcome,
            "error": None if error is None else error[:MAX_ERROR],
            "chars": self._chars,
            "words": self._words,
            "stages": list(self._stages),
        }


class HttpJobs:
    """A JobQueue fed by POST /jobs. image names the container's image in attempts."""

    def __init__(self, image: str = "") -> None:
        self._image = image
        self._started_at = iso_now()
        self._pending: deque[_Job] = deque()
        self._running: list[_Job] = []
        self._loading = True
        self._changed = threading.Condition()

    def add(self, raw: str) -> Answer:
        job = parse_job(raw)
        answer = Answer()
        with self._changed:
            self._pending.append(_Job(self._changed, job, raw, iso_now(), answer))
            self._changed.notify()
        return answer

    def loaded(self) -> None:
        """The pipelines are ready: jobs run from now on."""
        with self._changed:
            self._loading = False

    def busy(self) -> bool:
        with self._changed:
            return bool(self._running or self._pending)

    def state(self) -> JobsState:
        with self._changed:
            return {
                "loading": self._loading,
                "running": [j.received.job["doc"] for j in self._running],
                "waiting": [j.received.job["doc"] for j in self._pending],
                "startedAt": self._started_at,
                "jobs": [j.view() for j in (*self._running, *self._pending)],
            }

    def receive(self, timeout: float) -> Received | None:
        with self._changed:
            if not self._changed.wait_for(lambda: bool(self._pending), timeout):
                return None
            job = self._pending.popleft()
            job.started_at = iso_now()
            self._running.append(job)
            return job.received

    def ack(self, received: Received, result: JobResult) -> None:
        with self._changed:
            job = self._take(received)
            job.answer.attempted(job.attempt(self._image, result["outcome"], result["error"]))
        job.answer.give(result)

    def release(self, received: Received, error: str) -> None:
        # The next attempt has its own id, since the finished one keeps the old
        with self._changed:
            job = self._take(received)
            self._pending.append(
                _Job(self._changed, received.job, received.raw, job.accepted_at, job.answer)
            )
            job.answer.attempted(job.attempt(self._image, "retried", error))
            self._changed.notify()

    def _take(self, received: Received) -> _Job:
        job = next(j for j in self._running if j.received is received)
        self._running.remove(job)
        return job


def serve(jobs: HttpJobs, host: str, port: int) -> ThreadingHTTPServer:
    """Listen in a background thread; returns the server (shutdown() stops it)."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            if self.path != "/jobs":
                return self._reply(HTTPStatus.NOT_FOUND, {"error": "not found"})
            length = int(self.headers.get("content-length") or 0)
            if length > MAX_BODY_BYTES:
                return self._reply(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "too large"})
            raw = self.rfile.read(length).decode("utf-8", errors="replace")
            try:
                answer = jobs.add(raw)
            except (InvalidJob, ValueError) as error:
                return self._reply(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            self._reply(HTTPStatus.OK, answer.wait())

        def do_GET(self) -> None:
            if self.path == "/busy":
                return self._reply(HTTPStatus.OK, {"busy": jobs.busy()})
            if self.path == "/jobs":
                return self._reply(HTTPStatus.OK, jobs.state())
            self._reply(HTTPStatus.NOT_FOUND, {"error": "not found"})

        def _reply(self, status: HTTPStatus, body: object) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        @override
        def log_message(self, format: str, *args: object) -> None:
            log.debug(format, *args)

    server = ThreadingHTTPServer((host, port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
