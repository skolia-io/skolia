"""Blob storage: over HTTP (the ingest Worker's R2 binding) or a folder (tests)."""

from __future__ import annotations

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
    """GET and PUT {base}/{key}. In the container, base is a host the ingest Worker
    intercepts and serves from its R2 binding (Blobs in ingest/src/main.ts), so the
    container holds no credentials. Not retried here: the worker loop backs off on
    BlobError and puts the job back."""

    def __init__(self, base: str, timeout: float = 60) -> None:
        self._base = base.rstrip("/")
        self._timeout = timeout

    def get(self, key: str) -> bytes | None:
        return self._request("GET", key)

    def exists(self, key: str) -> bool:
        return self.get(key) is not None

    def put(self, key: str, data: bytes, content_type: str, encoding: str | None = None) -> None:
        headers = {"Content-Type": content_type}
        if encoding is not None:
            headers["Content-Encoding"] = encoding
        self._request("PUT", key, data, headers)

    def _request(
        self,
        method: str,
        key: str,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> bytes | None:
        """The body, or None for a 404"""
        request = urllib.request.Request(
            f"{self._base}/{quote(key)}", data, headers or {}, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise BlobError(f"{method.lower()} {key}: {error}") from error
        except OSError as error:
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
