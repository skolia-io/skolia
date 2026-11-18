// One run of ingest for a document: asks its language's container to analyse it, waits for
// the answer, and writes the document's status, ready or failed. A container that goes away
// before it answers fails the step, which is tried again.
//
// The API writes the queued status, then starts a run, named for the document and the bundle
// version it's to make (api/src/worker/adapters.ts IngestRuns), so a run asked for twice is one
// run. From then on the run writes the status.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { timestamp, type DocumentId } from "@skolia/shared/api";
import { statusKey } from "@skolia/shared/keys";
import type { JobResult, Status } from "@skolia/shared/schema";
import * as schemas from "@skolia/shared/schemas";
import { log } from "@skolia/util/log";
import type { Ingester } from "./main.ts";
import type { IngestParams } from "./rpc.ts";

const logger = log("ingest");

type Env = {
  INGESTER: DurableObjectNamespace<Ingester>;
  BLOBS: R2Bucket;
};

// The answer comes once the job has had its turn in the container's line and run: a minute
// or so for a text at the limit, after up to 2 min to start the container, and after the
// jobs ahead of it, which a sync of the curated texts makes many
const ANALYSE: WorkflowStepConfig = {
  retries: { limit: 3, delay: "1 minute", backoff: "exponential" },
  timeout: "1 hour",
};
const STATUS: WorkflowStepConfig = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" } };

export class IngestWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
  override async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep): Promise<Status["state"]> {
    const { doc, lang } = event.payload;
    let result: JobResult;
    try {
      result = await step.do("analyse", ANALYSE, async () =>
        schemas.JobResult.parse(await this.env.INGESTER.getByName(lang).analyse(lang, { doc, lang })),
      );
    } catch (error: unknown) {
      logger.error("ingest didn't answer", { doc, lang, run: event.instanceId, error });
      result = { outcome: "failed", analysis: null, error: `ingest didn't answer: ${String(error)}` };
    }
    await step.do("publish", STATUS, () => setStatus(this.env.BLOBS, doc, result));
    return result.outcome;
  }
}

/** Writes the document's status, ready or failed. A failed one keeps the last analysis's keys,
 * so the reader can still show it. */
async function setStatus(blobs: R2Bucket, doc: DocumentId, result: JobResult): Promise<void> {
  const updated = timestamp(new Date());
  const status = await (async (): Promise<Status> => {
    if (result.outcome === "ready" && result.analysis !== null) return { state: "ready", updated, ...result.analysis };
    const previous = await blobs.get(statusKey(doc));
    const parsed = previous === null ? null : schemas.Status.safeParse(await previous.json());
    const { analyzer, lexicon, analysis, bundle } = parsed?.success ? parsed.data : {};
    const kept = Object.fromEntries(Object.entries({ analyzer, lexicon, analysis, bundle }).filter(([, value]) => value !== undefined));
    return { ...kept, state: "failed", updated, error: result.error ?? "ingest failed without saying why" };
  })();
  await blobs.put(statusKey(doc), JSON.stringify(status), { httpMetadata: { contentType: "application/json" } });
}
