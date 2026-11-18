// One run of ingest for a document: hands the job to its language's container, waits for the
// container's events (IngestEvents in main.ts sends them on), and writes the document's status
// from them. A job lost with its container is heard nothing of, and handed over again.
//
// The API starts a run, named for the document and the bundle version it was asked for
// (api/src/worker/adapters.ts IngestRuns), after writing the document's queued status. From
// then on the run is what writes the status: analysing, then ready or failed.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { timestamp, type DocumentId, type IngestEvent, type Lang } from "@skolia/shared/api";
import { statusKey } from "@skolia/shared/keys";
import type { Made, Status } from "@skolia/shared/schema";
import * as schemas from "@skolia/shared/schemas";
import { log } from "@skolia/util/log";
import type { Ingester } from "./main.ts";
import type { IngestParams } from "./rpc.ts";

const logger = log("ingest");

type Env = {
  INGESTER: DurableObjectNamespace<Ingester>;
  BLOBS: R2Bucket;
};

// A container lost mid-job, or one that never took it, is given it again this many times in all
const MAX_ATTEMPTS = 3;
// Starting a container and waiting for it to listen takes up to 2 min (START_TIMEOUT_MS)
const HAND_OVER: WorkflowStepConfig = {
  retries: { limit: 4, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};
// Without an event for this long, the container is asked whether it still has the job; jobs
// wait their turn in its memory, so a long line is waited out, up to MAX_WAITS of these
const HEAR_WITHIN = "15 minutes";
const MAX_WAITS = 8;
const STATUS: WorkflowStepConfig = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" } };

type Kind = IngestEvent["kind"];

/** The event type a run waits for: an earlier attempt's late events don't count for a later one */
export function eventType(kind: Kind, attempt: number): string {
  return `${kind}-${attempt}`;
}

type Change =
  | { readonly state: "analysing" }
  | { readonly state: "failed"; readonly error: string }
  | { readonly state: "ready"; readonly made: Made };

export class IngestWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
  override async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep): Promise<Status["state"]> {
    const { doc, lang } = event.payload;
    const run = schemas.IngestRunId.parse(event.instanceId);
    const change = (name: string, to: Change) => step.do(name, STATUS, () => setStatus(this.env.BLOBS, doc, to));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let handed: "accepted" | "malformed";
      try {
        handed = await step.do(`hand over ${attempt}`, HAND_OVER, async () => {
          const [outcome] = await this.env.INGESTER.getByName(lang).route(lang, [{ doc, lang, run, attempt }]);
          if (outcome === "accepted" || outcome === "malformed") return outcome;
          throw new Error("ingest didn't accept the job");
        });
      } catch (error: unknown) {
        logger.error("handing the job over failed", { doc, lang, run, attempt, error });
        continue;
      }
      if (handed === "malformed") {
        await change("failed", { state: "failed", error: "ingest refused the job" });
        return "failed";
      }
      if ((await this.hear(step, "started", doc, lang, attempt)) === null) continue;
      await change(`analysing ${attempt}`, { state: "analysing" });
      const finished = await this.hear(step, "finished", doc, lang, attempt);
      if (finished?.kind !== "finished") continue;
      switch (finished.outcome) {
        case "ready":
          if (finished.made == null) {
            await change("failed", { state: "failed", error: "ingest finished without saying what it made" });
            return "failed";
          }
          await change("ready", { state: "ready", made: finished.made });
          return "ready";
        case "failed":
          await change("failed", { state: "failed", error: finished.error ?? "ingest failed" });
          return "failed";
        case "retried":
          // IngestEvents doesn't send these on: the container runs the job again itself
          throw new Error("a retried job's event reached its run");
      }
    }
    await change("failed", { state: "failed", error: `ingest didn't finish the job in ${MAX_ATTEMPTS} attempts` });
    return "failed";
  }

  /** The attempt's event of this kind, or null once the container no longer has the job. */
  private async hear(step: WorkflowStep, kind: Kind, doc: DocumentId, lang: Lang, attempt: number): Promise<IngestEvent | null> {
    for (let wait = 1; wait <= MAX_WAITS; wait++) {
      try {
        const { payload } = await step.waitForEvent<IngestEvent>(`${kind} ${attempt}.${wait}`, {
          type: eventType(kind, attempt),
          timeout: HEAR_WITHIN,
        });
        return payload;
      } catch {
        // Timed out: carry on waiting only while the container still has the job
        const held = await step.do(`${kind} ${attempt}.${wait}: still held?`, async () => {
          const jobs = await this.env.INGESTER.getByName(lang).jobs(lang);
          return jobs?.jobs.some((job) => job.doc === doc) ?? false;
        });
        if (!held) {
          logger.warn("ingest lost the job", { doc, lang, attempt, waiting: kind });
          return null;
        }
      }
    }
    logger.error("ingest held the job too long", { doc, lang, attempt, waiting: kind });
    return null;
  }
}

/** Writes the document's status, keeping the last analysis readable until a new one is ready. */
async function setStatus(blobs: R2Bucket, doc: DocumentId, change: Change): Promise<void> {
  const updated = timestamp(new Date());
  const status = await (async (): Promise<Status> => {
    switch (change.state) {
      case "ready":
        return { state: "ready", updated, ...change.made };
      case "analysing":
      case "failed": {
        const previous = await blobs.get(statusKey(doc));
        const parsed = previous === null ? null : schemas.Status.safeParse(await previous.json());
        const { analyzer, lexicon, analysis, bundle } = parsed?.success ? parsed.data : {};
        const kept = Object.fromEntries(Object.entries({ analyzer, lexicon, analysis, bundle }).filter(([, value]) => value !== undefined));
        return { ...kept, state: change.state, updated, ...(change.state === "failed" ? { error: change.error } : {}) };
      }
    }
  })();
  await blobs.put(statusKey(doc), JSON.stringify(status), { httpMetadata: { contentType: "application/json" } });
}
