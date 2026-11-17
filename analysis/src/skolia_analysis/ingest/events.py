"""Events about jobs, sent as they happen: one when an attempt at a job starts, one when
it finishes. The ingest Worker gets them (its container's outbound HTTP to
SKOLIA_EVENTS_URL goes to it, api/src/worker/ingest.ts) and stores them."""

from __future__ import annotations

import http.client
import json
import logging
import threading
import urllib.error
import urllib.request
from collections import deque
from typing import Literal, Protocol, TypedDict

from .jobs import Stage

log = logging.getLogger(__name__)

MAX_QUEUED = 1000
TIMEOUT_SECONDS = 10.0
MAX_BACKOFF_SECONDS = 60.0
# About 2 minutes of backing off, so one event the Worker fails on doesn't hold up the rest
MAX_ATTEMPTS = 8

Outcome = Literal["ready", "failed", "retried"]


class StageTime(TypedDict):
    stage: Stage
    ms: int


class StartedEvent(TypedDict):
    kind: Literal["started"]
    id: str
    doc: str
    lang: str
    image: str
    acceptedAt: str
    startedAt: str


class FinishedEvent(TypedDict):
    kind: Literal["finished"]
    id: str
    doc: str
    lang: str
    image: str
    acceptedAt: str
    startedAt: str
    finishedAt: str
    outcome: Outcome
    error: str | None
    chars: int | None
    words: int | None
    stages: list[StageTime]


Event = StartedEvent | FinishedEvent


class Events(Protocol):
    def send(self, event: Event) -> None:
        """Without waiting for it to be delivered."""
        ...

    def close(self, timeout: float) -> None:
        """Deliver what's queued, waiting at most timeout seconds."""
        ...


class LoggedEvents:
    """Where there's nowhere to send them."""

    def send(self, event: Event) -> None:
        log.debug("event %s", json.dumps(event))

    def close(self, timeout: float) -> None:
        pass


class Retry(Exception):
    pass


class Refused(Exception):
    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status
        self.body = body


def _body(error: urllib.error.HTTPError) -> str:
    """The start of a refusal's body, if it can be read"""
    try:
        return error.read()[:200].decode(errors="replace")
    except Exception:
        return ""


class HttpEvents:
    """POSTs each event to url from a background thread, so a slow or unreachable Worker
    doesn't hold up jobs. Failures that may pass are retried, backing off, up to
    max_attempts times; past max_queued events the oldest are dropped."""

    def __init__(
        self,
        url: str,
        *,
        max_queued: int = MAX_QUEUED,
        timeout: float = TIMEOUT_SECONDS,
        first_backoff: float = 1.0,
        max_backoff: float = MAX_BACKOFF_SECONDS,
        max_attempts: int = MAX_ATTEMPTS,
    ) -> None:
        self._url = url
        self._max_queued = max_queued
        self._timeout = timeout
        self._first_backoff = first_backoff
        self._max_backoff = max_backoff
        self._max_attempts = max_attempts
        self._queue: deque[Event] = deque()
        self._changed = threading.Condition()
        self._closing = False
        self._thread = threading.Thread(target=self._deliver, daemon=True)
        self._thread.start()

    def send(self, event: Event) -> None:
        with self._changed:
            if len(self._queue) >= self._max_queued:
                dropped = self._queue.popleft()
                log.warning(
                    "too many events queued: dropped %s %s of %s",
                    dropped["kind"],
                    dropped["id"],
                    dropped["doc"],
                )
            self._queue.append(event)
            self._changed.notify()

    def close(self, timeout: float) -> None:
        with self._changed:
            self._closing = True
            self._changed.notify()
        self._thread.join(timeout)
        with self._changed:
            if self._queue:
                log.warning("stopping with %d events undelivered", len(self._queue))

    def _deliver(self) -> None:
        while True:
            with self._changed:
                self._changed.wait_for(lambda: bool(self._queue) or self._closing)
                if not self._queue:
                    return
                event = self._queue[0]
            self._attempt(event)
            with self._changed:
                if self._is_next(event):
                    self._queue.popleft()

    def _attempt(self, event: Event) -> None:
        """Until it's delivered or refused, it's failed max_attempts times, or send() has
        dropped it. Once closing, it's tried once more without waiting."""
        failures = 0
        while self._is_next(event):
            with self._changed:
                final = self._closing
            try:
                self._post(event)
                return
            except Retry as error:
                failures += 1
                if final or failures >= self._max_attempts:
                    log.error(
                        "gave up sending %s event %s after %d attempts (%s)",
                        event["kind"],
                        event["id"],
                        failures,
                        error,
                    )
                    return
                delay = min(self._max_backoff, self._first_backoff * 2.0 ** (failures - 1))
                log.warning(
                    "sending %s event %s failed (%s); retrying in %.1f s",
                    event["kind"],
                    event["id"],
                    error,
                    delay,
                )
                with self._changed:
                    self._changed.wait_for(lambda: self._closing, delay)
            except Refused as error:
                log.error(
                    "%s event %s refused: %d %s",
                    event["kind"],
                    event["id"],
                    error.status,
                    error.body,
                )
                return
            except Exception:
                log.exception("sending %s event %s failed", event["kind"], event["id"])
                return

    def _is_next(self, event: Event) -> bool:
        """False once send() has dropped it as the oldest."""
        with self._changed:
            return bool(self._queue) and self._queue[0] is event

    def _post(self, event: Event) -> None:
        request = urllib.request.Request(
            self._url,
            data=json.dumps(event).encode(),
            method="POST",
            headers={
                "content-type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                status: int = response.status
        except urllib.error.HTTPError as error:
            if error.code == 429 or error.code >= 500:
                raise Retry(f"HTTP {error.code}") from error
            raise Refused(error.code, _body(error)) from error
        except (urllib.error.URLError, OSError, http.client.HTTPException) as error:
            raise Retry(str(error) or type(error).__name__) from error
        if status != 202:
            log.warning("%s event %s: expected 202, got %d", event["kind"], event["id"], status)
