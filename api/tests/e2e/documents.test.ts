import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { LANGS, type DocumentId, type ImportRequest, type Lang } from "@skolia/shared/api";
import { since } from "../../src/script-log.ts";
import { body, expectStatus } from "../../src/testing/responses.ts";
import { type Api, base, client, fetchOk, log, retryingFetch, runId, sleep, systemKey } from "./client.ts";

const TIMEOUT_MS = 10 * 60 * 1000;
const HISTORY_TIMEOUT_MS = 60_000;

const TEXTS: Record<Lang, string> = {
  en: "I'm looking for the dog that ran away last night.",
  fr: "Je cherche le chien qui s'est enfui hier soir.",
  pl: "Szukam psa, który uciekł wczoraj wieczorem.",
};

async function documents(t: TestContext, lang: Lang): Promise<void> {
  const api = client(base, systemKey);
  const anonymous = client(base);
  const fixture = `${runId}-${lang}`;
  const started = performance.now();
  const request: ImportRequest = {
    title: `end-to-end test ${fixture}`,
    text: `${TEXTS[lang]} Test ${fixture}.`,
    lang,
    visibility: "private",
  };
  const { id } = await body(`${lang} import`, api.documents.$post({ json: request }), 202);
  const imported = performance.now();
  t.after(async () => {
    await expectStatus(`${lang} remove fixture`, api.documents[":id"].$delete({ param: { id } }), 204);
  });
  log.info("{lang}: imported {doc}", { lang, doc: id, ms: since(started) });
  const [library, mine] = await Promise.all([
    body("library", anonymous.documents.$get({ query: { q: fixture } })),
    body("the importer's documents", api.documents.$get({ query: { q: fixture } })),
  ]);
  assert.ok(!library.items.some((d) => d.id === id), `${lang}: a private text is in the library`);
  assert.ok(
    mine.items.some((d) => d.id === id),
    `${lang}: the importer's list hasn't their private text`,
  );

  const deadline = Date.now() + TIMEOUT_MS;
  let delay = 1000;
  for (;;) {
    // As the importer, who's told where it is in the queue (from the ingest Worker)
    const summary = await body(`${lang} status`, api.documents[":id"].$get({ param: { id } }));
    log.info("{lang}: {state}", { lang, doc: id, state: summary.state, queue: summary.queue, ms: since(imported) });
    if (summary.state === "queued" || summary.state === "analysing") {
      assert.ok(summary.queue, `${lang}: ${summary.state} without its place in the queue`);
    }
    if (summary.state === "failed") throw new Error(`${lang} analysis failed: ${summary.error ?? ""}`);
    if (summary.state === "ready") {
      if (!summary.reading) throw new Error(`${lang}: ready without analysis and bundle names`);
      const verification = performance.now();
      const observedReadyAt = Date.now();
      const reading = summary.reading;
      // Finish outstanding reads before the test's cleanup removes the entry.
      const checks = await Promise.allSettled([
        (async () => {
          const url = `${base}/api/documents/${id}/text`;
          const text = await (await fetchOk(`${lang} text`, url, systemKey)).text();
          assert.equal(text, request.text, `${lang}: the text isn't the one imported`);
          const hidden = await retryingFetch(url);
          await hidden.body?.cancel();
          assert.equal(hidden.status, 404, `${lang}: a private text is readable signed out`);
        })(),
        (async () => {
          for (const [part, name] of Object.entries(reading)) {
            const blob = await fetchOk(`${lang} ${part}`, `${base}/api/documents/${id}/${part}/${name}`, systemKey);
            log.info("{lang}: {part} {name}", { lang, doc: id, part, name, bytes: (await blob.arrayBuffer()).byteLength });
          }
        })(),
        ingestHistory(api, anonymous, lang, id, observedReadyAt),
      ]);
      const failures = checks.flatMap((check) => (check.status === "rejected" ? [check.reason] : []));
      if (failures.length) throw new AggregateError(failures, `${lang}: document verification failed`);
      log.info("{lang}: verified document", { lang, doc: id, ms: since(verification) });
      return;
    }
    if (Date.now() > deadline) throw new Error(`${lang}: still ${summary.state} after ${TIMEOUT_MS / 60000} min`);
    await sleep(delay + Math.random() * 500);
    delay = Math.min(delay * 2, 5000);
  }
}

/** The analysis of a document just ready is in the ingest history once its run has recorded
 * it; signed out, the private text isn't. */
async function ingestHistory(api: Api, anonymous: Api, lang: Lang, id: DocumentId, observedReadyAt: number): Promise<void> {
  const deadline = Date.now() + HISTORY_TIMEOUT_MS;
  for (;;) {
    // A retried attempt's job comes before the one that made it ready
    const job = (await body(`${lang} ingest`, api.ingest.$get())).recent.find(
      (j) => j.document?.id === id && j.result?.outcome === "ready",
    );
    if (job?.result) {
      assert.ok(
        job.result.stages.some((s) => s.stage === "reading"),
        `${lang}: the job has no reading stage`,
      );
      const hidden = (await body(`${lang} ingest signed out`, anonymous.ingest.$get())).recent.find((j) => j.id === job.id);
      assert.ok(hidden, `${lang}: the job isn't in the ingest history signed out`);
      assert.equal(hidden.document, null, `${lang}: the ingest history shows a private text signed out`);
      const accepted = Date.parse(job.acceptedAt);
      const started = Date.parse(job.startedAt);
      const finished = Date.parse(job.result.finishedAt);
      log.info("{lang}: ingest job {job}", {
        lang,
        doc: id,
        job: job.id,
        acceptedToStartMs: started - accepted,
        processingMs: finished - started,
        finishToObservedReadyMs: observedReadyAt - finished,
        stages: job.result.stages,
      });
      return;
    }
    if (Date.now() > deadline) throw new Error(`${lang}: the job isn't ready in the ingest history after ${HISTORY_TIMEOUT_MS / 1000} s`);
    await sleep(1000);
  }
}

test("document ingestion", { concurrency: LANGS.length }, async (t) => {
  assert.ok(runId && systemKey, "e2e fixtures are required");
  await Promise.all(LANGS.map((lang) => t.test(lang, (scenario) => documents(scenario, lang))));
});
