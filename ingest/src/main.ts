// skolia-ingest on Cloudflare (ingest/wrangler.jsonc): runs ingest for a document as an
// IngestWorkflow (workflow.ts), which asks its language's analysis container (analysis/flake.nix,
// one image per language, served by analysis/src/skolia_analysis/ingest/http.py) to analyse it
// and waits for the answer. The container reads and writes blobs in R2 through this Worker's
// binding (Blobs).
//
// The containers use the durable_object scheduling policy, so each Ingester picks the
// image it starts. Jobs go to the Ingester named after their language's image: when a
// deploy changes an image, new jobs start a container with the new one while the old
// container finishes its jobs and stops.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { ContainerJobs, IngestJobRecord, Lang } from "@skolia/shared/api";
import type { IngestJob, JobAnswer } from "@skolia/shared/schema";
import * as schemas from "@skolia/shared/schemas";
import { log } from "@skolia/util/log";
import { D1IngestHistory } from "./history.ts";
import type { IngesterRpc } from "./rpc.ts";
import { IngestWorkflow } from "./workflow.ts";

export { IngestWorkflow };

const logger = log("ingest");

interface Env {
  INGESTER: DurableObjectNamespace<Ingester>;
  BLOBS: R2Bucket;
  /** skolia-ingest's D1 database: the jobs the containers ran */
  INGEST_DB: D1Database;
  /** How long the container stays up once idle; 1m by default, about what a start
   * costs (the models took 17 to 99 s to load, median 45 s, in 42 starts) */
  SLEEP_AFTER?: string;
}

const PORT = 8080;
const WARM_IDLE_MS = 3 * 60 * 1000;
const START_TIMEOUT_MS = 2 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5 * 1000;
// 1 vCPU, 6 GiB: Polish ingest peaked at 4.3 GiB on a 2,800-word text, English at 4.7 GiB
// (in Docker); the two languages in one container peaked at 6.7 GiB. French peaked at 3.5
// GiB on a 20,000-character text (analysis/EVALUATION.md)
const INSTANCE = "standard-2";
// How long past its last idle check a container keeps running if no further check
// comes, e.g. when an alarm fails
const INACTIVITY_MARGIN_MS = 5 * 60 * 1000;
// How long an idle container gets to exit on SIGTERM before it's killed; under
// blockConcurrencyWhile's 30 s
const STOP_TIMEOUT_MS = 10 * 1000;
const SIGTERM = 15;

/** The container's blob store, served by Blobs */
const BLOBS_HOST = "blobs.internal";

const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 } as const;

function milliseconds(duration: string): number {
  const match = /^(\d+)([smh])$/.exec(duration);
  if (match === null) throw new Error(`not a duration like 30s, 5m or 1h: ${duration}`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/**
 * One per language that only routes, and one per image that runs its container:
 * analyse() on the Ingester named after a language passes the job to the one named after
 * that language's image in this Worker version.
 *
 * An analysis makes no requests, so the container's inactivity timeout can't tell a
 * busy container from an idle one. An alarm asks it instead, SLEEP_AFTER after its last
 * job and then every SLEEP_AFTER while it's busy, and stops it once it's idle.
 */
export class Ingester extends DurableObject<Env> implements IngesterRpc {
  private readonly sleepAfterMs = milliseconds(this.env.SLEEP_AFTER ?? "1m");
  private starting: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A restarted Durable Object, e.g. after a deploy, has no timeout
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(this.inactivityTimeoutMs()));
    }
  }

  /** The job's result and attempts, once the container has run it. Throws when the container can't be
   * started or asked, or goes away before it answers: worth trying again. */
  async analyse(lang: Lang, job: IngestJob): Promise<JobAnswer> {
    return await this.env.INGESTER.getByName(this.image(lang)).run(this.image(lang), job);
  }

  /** The language's container's jobs (GET /jobs), on the Ingester named after the
   * language. Null when no container is running; it isn't started to find out. */
  async jobs(lang: Lang): Promise<ContainerJobs | null> {
    return await this.env.INGESTER.getByName(this.image(lang)).state();
  }

  recent(limit: number): Promise<readonly IngestJobRecord[]> {
    return new D1IngestHistory(this.env.INGEST_DB).recent(limit);
  }

  async state(): Promise<ContainerJobs | null> {
    const container = this.ctx.container;
    if (!container?.running) return null;
    let body: unknown;
    try {
      const response = await container.getTcpPort(PORT).fetch("http://ingest/jobs", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      body = await response.json();
    } catch {
      // Not listening yet
      return null;
    }
    const parsed = schemas.ContainerJobs.safeParse(body);
    if (!parsed.success) {
      logger.error("ingest's jobs aren't what was expected", { error: parsed.error.message });
      return null;
    }
    return parsed.data;
  }

  private image(lang: Lang): string {
    const image = this.container().images[lang];
    if (image === undefined) throw new Error(`no ingest image for ${lang}`);
    return image;
  }

  async warm(lang: Lang): Promise<void> {
    const image = this.image(lang);
    await this.env.INGESTER.getByName(image).warmImage(image);
  }

  async warmImage(image: string): Promise<void> {
    await this.ensureStarted(image);
    // Give the web deploy and e2e runner time to hand over the first job.
    await this.ctx.storage.setAlarm(Date.now() + WARM_IDLE_MS);
  }

  async run(image: string, job: IngestJob): Promise<JobAnswer> {
    const container = await this.ensureStarted(image);
    await this.ready(container);
    await this.ctx.storage.setAlarm(Date.now() + this.sleepAfterMs);
    return await this.post(container, job);
  }

  private async ensureStarted(image: string): Promise<Container> {
    const container = this.container();
    if (!container.running) {
      // One start for concurrent calls: registering the intercepts is async
      this.starting ??= this.start(container, image).finally(() => {
        this.starting = null;
      });
      await this.starting;
    }
    return container;
  }

  override async alarm(): Promise<void> {
    const container = this.ctx.container;
    if (!container?.running) return;
    // So that no job is handed over between the check and the container's exit: a job
    // that arrives meanwhile waits, then starts a new container
    await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.busy(container)) {
        logger.info("ingest is busy; keeping it awake");
        await this.ctx.storage.setAlarm(Date.now() + this.sleepAfterMs);
        return;
      }
      logger.info("ingest is idle; stopping it");
      // SIGTERM rather than destroy(), whose SIGKILL makes the exit look like a crash
      container.signal(SIGTERM);
      if (!(await this.stopped(container))) {
        logger.error("ingest didn't stop in time; killing it", { timeoutMs: STOP_TIMEOUT_MS });
        await container.destroy();
      }
    });
  }

  private async start(container: Container, image: string): Promise<void> {
    // Before start: an intercept lasts until the container stops
    await container.interceptOutboundHttp(BLOBS_HOST, this.ctx.exports.Blobs);
    container.start({
      image,
      instance: INSTANCE,
      enableInternet: false,
      env: { SKOLIA_BLOBS: `http://${BLOBS_HOST}`, SKOLIA_IMAGE: image },
    });
    logger.info("starting ingest", { image });
    this.ctx.waitUntil(
      container.monitor().then(
        () => logger.info("ingest exited", { image }),
        (error: unknown) => logger.error("ingest failed", { image, error }),
      ),
    );
    await container.setInactivityTimeout(this.inactivityTimeoutMs());
  }

  private container(): Container {
    const container = this.ctx.container;
    if (container === undefined) throw new Error("Ingester has no container");
    return container;
  }

  private inactivityTimeoutMs(): number {
    return this.sleepAfterMs + INACTIVITY_MARGIN_MS;
  }

  /** Whether the container exits within STOP_TIMEOUT_MS. Polled: the monitor() run()
   * started doesn't settle while blockConcurrencyWhile holds the object, so awaiting it
   * timed out in 138 of 143 stops, though the containers had exited. */
  private async stopped(container: Container): Promise<boolean> {
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (container.running) {
      if (Date.now() > deadline) return false;
      await scheduler.wait(250);
    }
    return true;
  }

  /** start() returns before the container listens */
  private async ready(container: Container): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      try {
        const response = await container.getTcpPort(PORT).fetch("http://ingest/busy", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        await response.body?.cancel();
        if (response.ok) return;
      } catch {
        // Not listening yet
      }
      if (!container.running) throw new Error("ingest stopped while starting");
      if (Date.now() > deadline) throw new Error(`ingest didn't listen within ${START_TIMEOUT_MS} ms`);
      await scheduler.wait(1000);
    }
  }

  /** POST /jobs, which answers once the job has run. A job the container refuses fails:
   * sent again, it would be refused again. */
  private async post(container: Container, job: IngestJob): Promise<JobAnswer> {
    const response = await container.getTcpPort(PORT).fetch("http://ingest/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(job),
    });
    const body = await response.text();
    if (response.status === 400) {
      logger.error("ingest refused job", { doc: job.doc, lang: job.lang, body });
      return { result: { outcome: "failed", analysis: null, error: { kind: "job-refused", status: response.status } }, attempts: [] };
    }
    if (!response.ok) throw new Error(`ingest answered ${response.status}: ${body}`);
    return schemas.JobAnswer.parse(JSON.parse(body));
  }

  private async busy(container: Container): Promise<boolean> {
    try {
      const response = await container.getTcpPort(PORT).fetch("http://ingest/busy", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const body: unknown = await response.json();
      return typeof body === "object" && body !== null && "busy" in body && body.busy === true;
    } catch (error: unknown) {
      logger.error("asking ingest whether it's busy failed", { error });
      return false;
    }
  }
}

// workerd refuses a Worker without a default export, though nothing calls this one
export default {} satisfies ExportedHandler<Env>;

/** GET and PUT /{key} on BLOBS_HOST for the container, from the R2 binding */
export class Blobs extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (request.method === "PUT") {
      await this.env.BLOBS.put(key, await request.arrayBuffer(), { httpMetadata: request.headers });
      return new Response(null, { status: 204 });
    }
    const object = await this.env.BLOBS.get(key);
    return new Response(object?.body ?? null, { status: object ? 200 : 404 });
  }
}
