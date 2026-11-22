import assert from "node:assert/strict";
import { test } from "node:test";
import { e2eUserId, e2eUserKey } from "@skolia/api/e2e-keys";
import { body, expectStatus } from "@skolia/util/responses";
import { client, runId, systemKey } from "./client.ts";

test("API key authentication", async () => {
  const seed = process.env["E2E_USER_KEY"];
  assert.ok(seed && systemKey && runId, "e2e fixtures are required");
  await expectStatus("/api/me without a key", client().me.$get(), 401);
  await expectStatus("/api/me with an unknown key", client("00".repeat(32)).me.$get(), 401);
  const system = await body("the system user", client(systemKey).me.$get());
  assert.deepEqual([system.id, system.roles], ["system", ["system"]]);
  const user = await body("the e2e user", client(e2eUserKey(seed, "en")).me.$get());
  assert.deepEqual([user.id, user.roles], [e2eUserId(runId, "en"), []]);
});
