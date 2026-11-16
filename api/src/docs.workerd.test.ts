import assert from "node:assert/strict";
import { test } from "node:test";
import { client, setup, useLocal } from "./testing/app.ts";
import { body, expectStatus } from "./testing/responses.ts";

useLocal();

test("the spec is served with the deploy's version, and the docs pages render it", async () => {
  const api = client(setup());
  const spec = await body("spec", api["openapi.json"].$get());
  assert.equal(spec.info.version, "v1.2.3");
  assert.ok("/api/documents" in spec.paths);
  const docs = await expectStatus("docs", api.docs.$get(), 302);
  assert.equal(docs.headers.get("location"), "/api/scalar");
  for (const [what, page] of [
    ["scalar", api.scalar],
    ["redoc", api.redoc],
  ] as const) {
    assert.match(await (await expectStatus(what, page.$get(), 200)).text(), /"\/api\/openapi\.json"/u);
  }
});
