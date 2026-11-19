// One run of ingest for a document: asks its language's container to analyse it, waits for
// the answer, writes the document's status, ready or failed, and adds the job's attempts to
// the ingest history. A container that goes away before it answers fails the step, which is
// tried again; the attempts it made are lost with it.
//
// The API writes the queued status, then starts a run, named for the document and the bundle
// version it's to make (api/src/worker/adapters/ingest.ts IngestRuns), so a run asked for twice is one
// run. From then on the run writes the status.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { timestamp, type DocumentId } from "@skolia/shared/api";
import { statusKey } from "@skolia/shared/keys";
import { compatibleStatus, type StatusPublisher } from "@skolia/shared/status";
import type { JobAnswer, JobResult, Status } from "@skolia/shared/schema";
import * as schemas from "@skolia/shared/schemas";
import { log } from "@skolia/util/log";
import { D1IngestHistory } from "./history.ts";
import type { Ingester } from "./main.ts";
import type { IngestParams } from "./rpc.ts";

const logger = log("ingest");

type Env = {
  INGESTER: DurableObjectNamespace<Ingester>;
  BLOBS: R2Bucket;
  INGEST_DB: D1Database;
  DOCUMENT_STATUS: StatusPublisher;
};

// The answer comes once the job has had its turn in the container's line and run: a minute
// or so for a text at the limit, after up to 2 min to start the container, and after the
// jobs ahead of it, which a sync of the curated texts makes many
const ANALYSE: WorkflowStepConfig = {
  retries: { limit: 3, delay: "1 minute", backoff: "exponential" },
  timeout: "1 hour",
};
const STORE: WorkflowStepConfig = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" } };
// How long jobs are kept in the history, from when they started
const HISTORY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export class IngestWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
  override async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep): Promise<Status["state"]> {
    const { doc, lang } = event.payload;
    let answer: JobAnswer;
    try {
      answer = await step.do("analyse", ANALYSE, async () =>
        schemas.JobAnswer.parse(await this.env.INGESTER.getByName(lang).analyse(lang, { doc, lang })),
      );
    } catch (error: unknown) {
      logger.error("ingest didn't answer", { doc, lang, run: event.instanceId, error });
      answer = { result: { outcome: "failed", analysis: null, error: `ingest didn't answer: ${String(error)}` }, attempts: [] };
    }
    const { result, attempts } = answer;
    await step.do("publish", STORE, () => setStatus(this.env.BLOBS, this.env.DOCUMENT_STATUS, doc, result));
    try {
      await step.do("record", STORE, async () => {
        const before = timestamp(new Date(Date.now() - HISTORY_DAYS * DAY_MS));
        await new D1IngestHistory(this.env.INGEST_DB).record(doc, lang, attempts, before);
      });
    } catch (error: unknown) {
      // The history is only shown: the document is ready (or failed) all the same
      logger.error("recording the job's attempts failed", { doc, lang, run: event.instanceId, attempts: attempts.length, error });
    }
    return result.outcome;
  }
}

/** Writes the document's status, ready or failed. A failed one keeps the last analysis's keys,
 * so the reader can still show it. */
async function setStatus(blobs: R2Bucket, publisher: StatusPublisher, doc: DocumentId, result: JobResult): Promise<void> {
  const updatedAt = timestamp(new Date());
  const status = await (async (): Promise<Status> => {
    if (result.outcome === "ready" && result.analysis !== null) return { state: "ready", updatedAt, artifacts: result.analysis };
    const previous = await blobs.get(statusKey(doc));
    const parsed = previous === null ? null : schemas.CompatibleStatus.safeParse(await previous.json());
    const artifacts = parsed?.success ? parsed.data.artifacts : undefined;
    return {
      state: "failed",
      updatedAt,
      error: result.error ?? "ingest failed without saying why",
      ...(artifacts === undefined ? {} : { artifacts }),
    };
  })();
  await publisher.publish(doc, compatibleStatus(status));
}
