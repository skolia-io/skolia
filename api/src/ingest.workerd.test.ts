import assert from "node:assert/strict";
import { test } from "node:test";
import { D1IngestHistory } from "@skolia/ingest/history";
import type { DocumentId, Lang, Timestamp } from "@skolia/shared/api";
import type { JobAttempt } from "@skolia/shared/schema";
import { ALICE, client, importer, ingestJobs, local, setup, useLocal, type App } from "./testing/app.ts";
import { body } from "@skolia/util/responses";

useLocal();

const at = (time: string) => `2026-11-17T${time}.000Z` as Timestamp;
const IMAGE = "skolia-ingest-pl:test";

function attempt(id: string, startedAt: Timestamp, fields: Partial<JobAttempt> = {}): JobAttempt {
  return {
    id,
    image: IMAGE,
    acceptedAt: at("09:00:00"),
    startedAt,
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

/** A row for a job that started before runs recorded jobs whole, and never finished */
async function unfinished(id: string, doc: DocumentId, startedAt: Timestamp): Promise<void> {
  await local.env.INGEST_DB.prepare(
    "INSERT INTO ingest_job (id, document_id, lang, image, accepted_at, started_at) VALUES (?, ?, 'pl', ?, ?, ?)",
  )
    .bind(id, doc, IMAGE, at("09:00:00"), startedAt)
    .run();
}

async function imported(app: App, headers: Headers, title: string, text: string, visibility: "public" | "private"): Promise<DocumentId> {
  const json = { title, text, lang: "pl" as Lang, visibility, licence: "cc0" as const };
  return (await body("import", client(app, headers).documents.$post({ json }), 202)).id;
}

test("anyone sees what analysis is doing, without the texts they can't see", async () => {
  const shared = await imported(setup(), importer, "Shared", "Jest kot.", "public");
  const secret = await imported(setup(), importer, "Secret", "Jest pies.", "private");
  const history = new D1IngestHistory(local.env.INGEST_DB);
  await history.record(shared, "pl", [attempt("done", at("09:00:05"))], at("00:00:00"));
  await history.record(secret, "pl", [attempt("failed", at("09:00:10"), { outcome: "failed", error: "missing-text" })], at("00:00:00"));
  // Its container stopped before it finished
  await unfinished("lost", shared, at("09:00:20"));
  // Still running: shown with its container
  await unfinished("running", secret, at("09:01:01"));
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
  assert.deepEqual(anyone.recent[2]?.result?.stages, attempt("x", at("09:00:00")).stages);
  assert.equal(JSON.stringify(anyone).includes(secret), false);

  const response = await local.server.getWorker().fetch("/api/ingest");
  assert.equal(response.status, 200);
  const overview = (await response.json()) as typeof anyone;
  assert.deepEqual(
    overview.recent.find((job) => job.id === "done"),
    anyone.recent.find((job) => job.id === "done"),
  );
  assert.equal(JSON.stringify(overview).includes(secret), false);

  const owner = await body("importer", client(app, importer).ingest.$get());
  assert.deepEqual(owner.languages[2]?.container?.jobs[0]?.document, { id: secret, title: "Secret" });
  assert.equal(owner.recent[1]?.result?.error, "missing-text");

  const alice = await local.signIn((await local.signUp(ALICE)).id);
  assert.equal((await body("someone else", client(app, alice).ingest.$get())).recent[1]?.document, null);
});

test("a job's attempts are recorded once, however often its run records them, and old jobs go", async () => {
  const doc = "a".repeat(64) as DocumentId;
  const history = new D1IngestHistory(local.env.INGEST_DB);
  const attempts = [attempt("one", at("08:00:00"), { outcome: "retried", error: "storage-unavailable" }), attempt("two", at("08:01:00"))];
  await history.record(doc, "pl", attempts, at("00:00:00"));
  await history.record(doc, "pl", attempts, at("00:00:00"));
  assert.deepEqual(
    (await history.recent(50)).map((job) => [job.id, job.doc, job.result?.outcome ?? null]),
    [
      ["two", doc, "ready"],
      ["one", doc, "retried"],
    ],
  );
  await history.record(doc, "pl", [attempt("three", at("10:00:00"))], at("08:00:30"));
  assert.deepEqual(
    (await history.recent(50)).map((job) => job.id),
    ["three", "two"],
  );
});
