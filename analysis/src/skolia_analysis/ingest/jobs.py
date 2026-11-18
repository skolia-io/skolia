"""The job queue ingest takes from: HttpJobs (http.py), fed by the ingest Worker's
IngestWorkflow runs, and MemoryQueue for tests."""

from __future__ import annotations

import json
from collections import deque
from typing import Literal, Protocol, TypedDict, cast

from .schema import IngestJob, Made

Stage = Literal[
    "reading",
    "loading-analysis",
    "analysing",
    "bundling",
    "compressing-analysis",
    "uploading-analysis",
    "compressing-bundle",
    "uploading-bundle",
]


class JobResult(TypedDict):
    """How a job ended: what it made, or why it failed. The run that asked for it writes
    the document's status from it."""

    outcome: Literal["ready", "failed"]
    made: Made | None
    error: str | None


class InvalidJob(ValueError):
    pass


class Progress(Protocol):
    """Told how a job is getting on, so the queue can show it."""

    def text(self, chars: int, words: int) -> None: ...

    def stage_started(self, stage: Stage) -> None: ...

    def stage_finished(self, stage: Stage, ms: int) -> None:
        """Called whether the stage succeeded or failed."""
        ...


class NoProgress:
    def text(self, chars: int, words: int) -> None:
        pass

    def stage_started(self, stage: Stage) -> None:
        pass

    def stage_finished(self, stage: Stage, ms: int) -> None:
        pass


NO_PROGRESS = NoProgress()


class Received:
    def __init__(self, job: IngestJob, raw: str, progress: Progress = NO_PROGRESS) -> None:
        self.job = job
        self.raw = raw
        self.progress = progress


class JobQueue(Protocol):
    def receive(self, timeout: float) -> Received | None:
        """The next job, waiting up to timeout seconds. None if there's none."""
        ...

    def ack(self, received: Received, result: JobResult) -> None:
        """Done with the job, ready or failed as result says: don't deliver it again."""
        ...

    def release(self, received: Received, error: str) -> None:
        """Not done, for the reason given: deliver the job again later."""
        ...


def parse_job(raw: str) -> IngestJob:
    value: object = json.loads(raw)
    if not isinstance(value, dict):
        raise InvalidJob(f"not an object: {raw!r}")
    fields = cast(dict[str, object], value)
    doc, lang, run, attempt = (fields.get(k) for k in ("doc", "lang", "run", "attempt"))
    if not isinstance(doc, str) or not isinstance(lang, str) or not isinstance(run, str):
        raise InvalidJob(f"needs string doc, lang and run: {raw!r}")
    if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1:
        raise InvalidJob(f"needs a positive integer attempt: {raw!r}")
    return {"doc": doc, "lang": lang, "run": run, "attempt": attempt}


class MemoryQueue:
    """For tests."""

    def __init__(self) -> None:
        self.pending: deque[str] = deque()
        self.acked: list[IngestJob] = []
        self.released: list[IngestJob] = []

    def send(self, job: IngestJob) -> None:
        self.pending.append(json.dumps(job))

    def receive(self, timeout: float) -> Received | None:
        if not self.pending:
            return None
        raw = self.pending.popleft()
        return Received(parse_job(raw), raw)

    def ack(self, received: Received, result: JobResult) -> None:
        self.acked.append(received.job)

    def release(self, received: Received, error: str) -> None:
        self.released.append(received.job)
        self.pending.append(received.raw)
