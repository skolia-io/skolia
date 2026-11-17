"""Blob storage: over HTTP (the ingest Worker's R2 binding) or a folder (tests)."""

from __future__ import annotations

import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Protocol
from urllib.parse import quote

BROTLI = "br"
"""Content-Encoding of the analysis and bundle. Measured on Kamizelka against gzip -9
and zstd -22: Brotli -11 was 41% (analysis) and 60% (bundle) the size of gzip, and
11-17% smaller than zstd. Browsers decode it natively over HTTPS."""


class BlobError(Exception):
    """Storage failed (after the client's own retries): try the job again later."""


class Blobs(Protocol):
    """Every method raises BlobError when storage fails; a missing key isn't a failure."""

    def get(self, key: str) -> bytes | None:
        """The object's stored bytes (still compressed if it was put with an encoding)."""
        ...

    def exists(self, key: str) -> bool: ...

    def put(
        self, key: str, data: bytes, content_type: str, encoding: str | None = None
    ) -> None: ...


class HttpBlobs:
    """Blobs over plain HTTP: GET, HEAD and PUT {base}/{key}. In the container, base is the
    ingest Worker's intercepted host, which serves them from its R2 binding
    (api/src/worker/blob-http.ts), so the container holds no credentials."""

    ENCODING = "x-blob-content-encoding"
    """The PUT header for Content-Encoding (blob-http.ts BLOB_ENCODING)"""

    def __init__(
        self, base: str, attempts: int = 3, timeout: float = 60, backoff: float = 1
    ) -> None:
        self._base = base.rstrip("/")
        self._attempts = attempts
        self._timeout = timeout
        self._backoff = backoff

    def get(self, key: str) -> bytes | None:
        status, body = self._request("GET", key)
        return None if status == 404 else body

    def exists(self, key: str) -> bool:
        status, _ = self._request("HEAD", key)
        return status != 404

    def put(self, key: str, data: bytes, content_type: str, encoding: str | None = None) -> None:
        headers = {"Content-Type": content_type}
        if encoding is not None:
            headers[self.ENCODING] = encoding
        self._request("PUT", key, data, headers)

    def _request(
        self,
        method: str,
        key: str,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, bytes]:
        """The status and body of a 2xx or 404; anything else is retried, then a BlobError."""
        url = f"{self._base}/{quote(key)}"
        error: Exception | None = None
        for attempt in range(self._attempts):
            if attempt > 0:
                time.sleep(self._backoff * 2**attempt)
            request = urllib.request.Request(url, data, headers or {}, method=method)
            try:
                with urllib.request.urlopen(request, timeout=self._timeout) as response:
                    return response.status, response.read()
            except urllib.error.HTTPError as failure:
                if failure.code == 404:
                    return 404, b""
                error = failure
            except (urllib.error.URLError, OSError) as failure:
                error = failure
        raise BlobError(f"{method.lower()} {key}: {error}") from error


class DirBlobs:
    """Blobs as files under a folder; keys become relative paths."""

    def __init__(self, root: Path) -> None:
        self._root = root

    def get(self, key: str) -> bytes | None:
        path = self._root / key
        try:
            return path.read_bytes() if path.exists() else None
        except OSError as error:
            raise BlobError(f"get {key}: {error}") from error

    def exists(self, key: str) -> bool:
        return (self._root / key).exists()

    def put(self, key: str, data: bytes, content_type: str, encoding: str | None = None) -> None:
        path = self._root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
