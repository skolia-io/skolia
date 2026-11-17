import threading
from collections.abc import Iterator
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

import pytest

from skolia_analysis.ingest.blobs import BlobError, HttpBlobs


@dataclass(frozen=True)
class Stored:
    data: bytes
    content_type: str | None
    encoding: str | None


class FakeStore(ThreadingHTTPServer):
    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), Handler)
        self.objects: dict[str, Stored] = {}
        self.failures = 0


class Handler(BaseHTTPRequestHandler):
    @property
    def store(self) -> FakeStore:
        assert isinstance(self.server, FakeStore)
        return self.server

    def log_message(self, format: str, *args: object) -> None:
        pass

    def _key(self) -> str:
        return unquote(self.path[1:])

    def _fail(self) -> bool:
        if self.store.failures == 0:
            return False
        self.store.failures -= 1
        self.send_response(500)
        self.send_header("Content-Length", "0")
        self.end_headers()
        return True

    def do_GET(self) -> None:
        if self._fail():
            return
        stored = self.store.objects.get(self._key())
        self.send_response(404 if stored is None else 200)
        body = b"" if stored is None else stored.data
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_HEAD(self) -> None:
        self.send_response(404 if self._key() not in self.store.objects else 200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_PUT(self) -> None:
        if self._fail():
            return
        data = self.rfile.read(int(self.headers["Content-Length"]))
        self.store.objects[self._key()] = Stored(
            data, self.headers["Content-Type"], self.headers[HttpBlobs.ENCODING]
        )
        self.send_response(204)
        self.end_headers()


@pytest.fixture
def store() -> Iterator[FakeStore]:
    server = FakeStore()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()


def blobs_of(store: FakeStore) -> HttpBlobs:
    host, port = store.server_address[:2]
    return HttpBlobs(f"http://{host!s}:{port}", attempts=3, backoff=0)


def test_put_then_get_and_exists(store: FakeStore) -> None:
    blobs = blobs_of(store)
    blobs.put("doc/a b/analysis.json", b"\x8b\x00compressed", "application/json", "br")
    assert store.objects["doc/a b/analysis.json"] == Stored(
        b"\x8b\x00compressed", "application/json", "br"
    )
    assert blobs.get("doc/a b/analysis.json") == b"\x8b\x00compressed"
    assert blobs.exists("doc/a b/analysis.json")


def test_missing_key_is_none_not_an_error(store: FakeStore) -> None:
    blobs = blobs_of(store)
    assert blobs.get("nothing") is None
    assert not blobs.exists("nothing")


def test_a_put_without_encoding_sends_none(store: FakeStore) -> None:
    blobs_of(store).put("status.json", b"{}", "application/json")
    assert store.objects["status.json"].encoding is None


def test_server_errors_are_retried(store: FakeStore) -> None:
    store.failures = 2
    blobs_of(store).put("k", b"v", "text/plain")
    assert store.objects["k"].data == b"v"


def test_persistent_errors_raise_blob_error(store: FakeStore) -> None:
    store.failures = 3
    with pytest.raises(BlobError, match="get k"):
        blobs_of(store).get("k")
