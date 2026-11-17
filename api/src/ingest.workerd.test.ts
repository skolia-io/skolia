import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocumentId, IngestEvent, IngestResult, Lang, Timestamp } from "@skolia/shared/api";
import { ALICE, client, importer, ingestJobs, local, setup, useLocal, type App } from "./testing/app.ts";
import { body, expectStatus } from "./testing/responses.ts";
import { D1IngestHistory, receiveEvent } from "./worker/ingest-history.ts";

useLocal();

const at = (time: string) => `2026-11-17T${time}.000Z` as Timestamp;
const IMAGE = "skolia-ingest-pl:test";

function started(id: string, doc: DocumentId, startedAt: Timestamp): Extract<IngestEvent, { kind: "started" }> {
  return { kind: "started", id, doc, lang: "pl", image: IMAGE, acceptedAt: at("09:00:00"), startedAt };
}

function finished(
  id: string,
  doc: DocumentId,
  startedAt: Timestamp,
  fields: Partial<IngestResult> = {},
): Extract<IngestEvent, { kind: "finished" }> {
  return {
    ...started(id, doc, startedAt),
    kind: "finished",
    finishedAt: at("09:30:00"),
    outcome: "ready",
    error: null,
    chars: 19,
    words: 4,
    stages: [
      { stage: "reading", ms: 12 },
      { stage: "analysing", ms: 3400 },
    ],
    ...fields,
  };
}

async function imported(app: App, headers: Headers, title: string, text: string, visibility: "public" | "private"): Promise<DocumentId> {
  const json = { title, text, lang: "pl" as Lang, visibility, licence: "cc0" as const };
  return (await body("import", client(app, headers).documents.$post({ json }), 202)).id;
}

test("anyone sees what analysis is doing, without the texts they can't see", async () => {
  const shared = await imported(setup(), importer, "Shared", "Jest kot.", "public");
  const secret = await imported(setup(), importer, "Secret", "Jest pies.", "private");
  await new D1IngestHistory(local.env.INGEST_DB).record(
    [
      finished("done", shared, at("09:00:05")),
      finished("failed", secret, at("09:00:10"), { outcome: "failed", error: `no text at texts/${secret}` }),
      // Its container stopped before it finished
      started("lost", shared, at("09:00:20")),
      // Still running: shown with its container
      started("running", secret, at("09:01:01")),
    ],
    at("00:00:00"),
  );
  const running = {
    id: "running",
    doc: secret,
    lang: "pl" as const,
    acceptedAt: at("09:01:00"),
    startedAt: at("09:01:01"),
    stage: "analysing" as const,
    stageStartedAt: at("09:01:02"),
    chars: 10,
    words: 2,
    stages: [{ stage: "reading" as const, ms: 9 }],
  };
  const waiting = {
    ...running,
    id: "waiting",
    doc: shared,
    startedAt: null,
    stage: null,
    stageStartedAt: null,
    chars: null,
    words: null,
    stages: [],
  };
  const app = setup({
    jobsOf: async (lang) =>
      lang === "pl" ? ingestJobs({ startedAt: at("08:59:00"), running: [secret], waiting: [shared], jobs: [running, waiting] }) : null,
  });

  const anyone = await body("signed out", client(app).ingest.$get());
  assert.deepEqual(
    anyone.languages.map(({ lang, container }) => ({ lang, jobs: container?.jobs.map((job) => [job.id, job.document]) ?? null })),
    [
      { lang: "en", jobs: null },
      { lang: "fr", jobs: null },
      {
        lang: "pl",
        jobs: [
          ["running", null],
          ["waiting", { id: shared, title: "Shared" }],
        ],
      },
    ],
  );
  assert.deepEqual(
    anyone.recent.map((job) => [job.id, job.document?.title ?? null, job.result?.outcome ?? null, job.result?.error ?? null]),
    [
      ["lost", "Shared", null, null],
      ["failed", null, "failed", null],
      ["done", "Shared", "ready", null],
    ],
  );
  assert.deepEqual(anyone.recent[2]?.result?.stages, finished("x", shared, at("09:00:00")).stages);
  assert.equal(JSON.stringify(anyone).includes(secret), false);

  const owner = await body("importer", client(app, importer).ingest.$get());
  assert.deepEqual(owner.languages[2]?.container?.jobs[0]?.document, { id: secret, title: "Secret" });
  assert.equal(owner.recent[1]?.result?.error, `no text at texts/${secret}`);

  const alice = await local.signIn((await local.signUp(ALICE)).id);
  assert.equal((await body("someone else", client(app, alice).ingest.$get())).recent[1]?.document, null);
});

test("a job's events make one row, in either order and either twice, and old jobs go", async () => {
  const doc = "a".repeat(64) as DocumentId;
  const history = new D1IngestHistory(local.env.INGEST_DB);
  await history.record([finished("one", doc, at("08:00:00")), started("one", doc, at("08:00:00"))], at("00:00:00"));
  await history.record([started("two", doc, at("10:00:00")), started("two", doc, at("10:00:00"))], at("00:00:00"));
  assert.deepEqual(
    (await history.recent(50)).map((job) => [job.id, job.result?.outcome ?? null]),
    [
      ["two", null],
      ["one", "ready"],
    ],
  );
  await history.record([finished("two", doc, at("10:00:00"))], at("09:00:00"));
  assert.deepEqual(
    (await history.recent(50)).map((job) => [job.id, job.result?.outcome ?? null]),
    [["two", "ready"]],
  );
});

test("the ingest Worker passes on what a container sends only if it's an event", async () => {
  const sent: IngestEvent[] = [];
  const receive = (method: string, body?: string) =>
    receiveEvent(async (event) => void sent.push(event), new Request("http://events.internal/", { method, body: body ?? null }));
  const event = started("e1", "b".repeat(64) as DocumentId, at("09:00:00"));
  assert.equal((await receive("GET")).status, 404);
  assert.equal((await receive("POST", "not json")).status, 400);
  assert.equal((await receive("POST", JSON.stringify({ kind: "lost" }))).status, 400);
  const readyWithError = { ...finished("e0", event.doc, at("09:01:00")), error: "but how" };
  assert.equal((await receive("POST", JSON.stringify(readyWithError))).status, 400);
  assert.equal((await receive("POST", JSON.stringify(event))).status, 202);
  assert.deepEqual(sent, [event]);
});
