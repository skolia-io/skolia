import assert from "node:assert/strict";
import { test } from "node:test";
import { Semaphore } from "./semaphore.ts";

test("a semaphore lets limit holders in at once, and the next in as one disposes its permit", async () => {
  const semaphore = new Semaphore(2);
  const first = await semaphore.acquire();
  const second = await semaphore.acquire();
  let third = false;
  const waiting = semaphore.acquire().then((permit) => {
    third = true;
    return permit;
  });
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(third, false);
  first[Symbol.dispose]();
  first[Symbol.dispose]();
  using permit = await waiting;
  assert.equal(third, true);
  second[Symbol.dispose]();
  {
    using again = await semaphore.acquire();
    assert.ok(again);
  }
  assert.ok(permit);
  assert.throws(() => new Semaphore(0), /at least 1 permit/);
});
