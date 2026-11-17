import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOB_ENCODING, BLOBS_HOST, serveBlob } from "./worker/blob-http.ts";
import { local, useLocal } from "./testing/app.ts";

useLocal();

function request(method: string, key: string, init: RequestInit = {}): Request {
  return new Request(`http://${BLOBS_HOST}/${encodeURIComponent(key)}`, { method, ...init });
}

test("a PUT stores the bytes with their type and encoding, and GET returns them as stored", async () => {
  const bytes = new Uint8Array([0x8b, 0x00, 0xff, 0x10]);
  const put = await serveBlob(
    local.env.BLOBS,
    request("PUT", "doc/a b/analysis.json", { body: bytes, headers: { "content-type": "application/json", [BLOB_ENCODING]: "br" } }),
  );
  assert.equal(put.status, 204);
  const stored = await local.env.BLOBS.get("doc/a b/analysis.json");
  assert.deepEqual(stored?.httpMetadata, { contentType: "application/json", contentEncoding: "br" });
  const got = await serveBlob(local.env.BLOBS, request("GET", "doc/a b/analysis.json"));
  assert.equal(got.status, 200);
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes);
  assert.equal((await serveBlob(local.env.BLOBS, request("HEAD", "doc/a b/analysis.json"))).status, 200);
});

test("a missing key is a 404, and other methods are refused", async () => {
  assert.equal((await serveBlob(local.env.BLOBS, request("GET", "nothing"))).status, 404);
  assert.equal((await serveBlob(local.env.BLOBS, request("HEAD", "nothing"))).status, 404);
  assert.equal((await serveBlob(local.env.BLOBS, request("DELETE", "nothing"))).status, 405);
  assert.equal((await serveBlob(local.env.BLOBS, new Request(`http://${BLOBS_HOST}/`))).status, 400);
});
