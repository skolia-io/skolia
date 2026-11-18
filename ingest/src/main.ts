// skolia-ingest on Cloudflare (ingest/wrangler.jsonc): consumes the ingest queue
// and hands each job to its language's analysis container (analysis/flake.nix, one
// image per language, served by analysis/src/skolia_analysis/ingest/http.py), which
// reads and writes status and blobs in R2 through this Worker's binding (Blobs).
//
// A message is acked once the container has accepted the job, not when the analysis
// is done: a queue consumer may run for at most 15 minutes, and a long text can take
// longer. A job lost with its container is caught by the API, which queues a document
// again once it has been queued or analysing for too long (STUCK_AFTER_MS in app.ts).
//
// The containers use the durable_object scheduling policy, so each Ingester picks the
// image it starts. Jobs go to the Ingester named after their language's image: when a
// deploy changes an image, new jobs start a container with the new one while the old
// container finishes its jobs and stops.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { isLang, timestamp, type ContainerJobs, type IngestEvent, type IngestJobRecord, type Lang } from "@skolia/shared/api";
import type { IngestJob } from "@skolia/shared/schema";
import * as schemas from "@skolia/shared/schemas";
import { log } from "@skolia/util/log";
import { D1IngestHistory, receiveEvent } from "./history.ts";
import type { IngesterRpc } from "./rpc.ts";

const logger = log("ingest");

interface Env {
  INGESTER: DurableObjectNamespace<Ingester>;
  BLOBS: R2Bucket;
  /** skolia-ingest's D1 database: the jobs the containers ran */
  INGEST_DB: D1Database;
  /** The containers' events (IngestEvents), which this Worker consumes into INGEST_DB */
  INGEST_EVENTS: Queue<IngestEvent>;
  /** INGEST_EVENTS's name, which tells its batches from the jobs' */
  INGEST_EVENTS_QUEUE: string;
  /** How long the container stays up once idle; 1m by default, about what a start
   * costs (the models took 17 to 99 s to load, median 45 s, in 42 starts) */
  SLEEP_AFTER?: string;
}

const PORT = 8080;
// The host a container sends its events to: Ingester routes it to IngestEvents
// (interceptOutboundHttp), so they never leave the machine
const EVENTS_HOST = "events.internal";
const RETRY_DELAY_SECONDS = 60;
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
// How long jobs are kept in INGEST_DB, from when they started
const HISTORY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The container's blob store, served by Blobs */
const BLOBS_HOST = "blobs.internal";

/** What became of a job handed to the container */
type Outcome = "accepted" | "malformed" | "failed";

const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 } as const;

function milliseconds(duration: string): number {
  const match = /^(\d+)([smh])$/.exec(duration);
  if (match === null) throw new Error(`not a duration like 30s, 5m or 1h: ${duration}`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/**
 * One per language that only routes, and one per image that runs its container:
 * route() on the Ingester named after a language passes the jobs to the one named after
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

  async route(lang: Lang, jobs: IngestJob[]): Promise<Outcome[]> {
    return await this.env.INGESTER.getByName(this.image(lang)).run(this.image(lang), jobs);
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

  async run(image: string, jobs: IngestJob[]): Promise<Outcome[]> {
    const container = this.container();
    if (!container.running) {
      // One start for concurrent calls: registering the intercepts is async
      this.starting ??= this.start(container, image).finally(() => {
        this.starting = null;
      });
      await this.starting;
    }
    await this.ready(container);
    await this.ctx.storage.setAlarm(Date.now() + this.sleepAfterMs);
    const outcomes: Outcome[] = [];
    for (const job of jobs) outcomes.push(await this.post(container, job));
    return outcomes;
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
    await container.interceptOutboundHttp(EVENTS_HOST, this.ctx.exports.IngestEvents);
    container.start({
      image,
      instance: INSTANCE,
      enableInternet: false,
      env: { SKOLIA_BLOBS: `http://${BLOBS_HOST}`, SKOLIA_IMAGE: image, SKOLIA_EVENTS_URL: `http://${EVENTS_HOST}/` },
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

  private async post(container: Container, job: IngestJob): Promise<Outcome> {
    try {
      const response = await container.getTcpPort(PORT).fetch("http://ingest/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(job),
      });
      // Always read the body: the container counts a request as in flight until its
      // body is consumed, and would never be idle
      const body = await response.text();
      if (response.status === 202) return "accepted";
      if (response.status === 400) {
        logger.error("ingest refused job", { doc: job.doc, lang: job.lang, body });
        return "malformed";
      }
      logger.error("ingest answered with an error", { doc: job.doc, lang: job.lang, status: response.status, body });
      return "failed";
    } catch (error: unknown) {
      logger.error("handing job to ingest failed", { doc: job.doc, lang: job.lang, error });
      return "failed";
    }
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

export default {
  async queue(batch, env) {
    if (batch.queue === env.INGEST_EVENTS_QUEUE) {
      await store(env, batch as MessageBatch<unknown>);
      return;
    }
    logger.info("received jobs", {
      docs: batch.messages.map((message) => message.body.doc),
      attempts: batch.messages.map((message) => message.attempts),
    });
    const byLang = new Map<Lang, Message<IngestJob>[]>();
    for (const message of batch.messages) {
      const lang = message.body.lang;
      if (!isLang(lang)) {
        // The API only queues languages it knows: retrying won't help
        logger.error("no ingest for language", { job: message.body });
        message.ack();
        continue;
      }
      byLang.set(lang, [...(byLang.get(lang) ?? []), message]);
    }
    await Promise.all([...byLang].map(([lang, messages]) => handOver(env, lang, messages)));
  },
} satisfies ExportedHandler<Env, IngestJob>;

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

/** A container's events: it POSTs each to EVENTS_HOST, and they're queued for this Worker
 * to store (store below) */
export class IngestEvents extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    // JSON, as the jobs' queue, so a message can be read outside a Worker
    const send = async (event: IngestEvent) => void (await this.env.INGEST_EVENTS.send(event, { contentType: "json" }));
    return await receiveEvent(send, request);
  }
}

/** Stores the containers' events. One that isn't an event is dropped, since it never will
 * be; the batch is retried if storing fails. */
async function store(env: Env, batch: MessageBatch<unknown>): Promise<void> {
  const parsed = batch.messages.flatMap((message): { message: Message<unknown>; event: IngestEvent }[] => {
    const event = schemas.IngestEvent.safeParse(message.body);
    if (event.success) return [{ message, event: event.data }];
    logger.error("not an ingest event", { body: message.body, error: event.error.message });
    return [];
  });
  const before = timestamp(new Date(Date.now() - HISTORY_DAYS * DAY_MS));
  const history = new D1IngestHistory(env.INGEST_DB);
  try {
    await history.record(
      parsed.map(({ event }) => event),
      before,
    );
    logger.info("stored ingest events", { events: parsed.length });
  } catch (error: unknown) {
    // One the database refuses fails the batch; store them one at a time, so only it's retried
    logger.warn("storing ingest events together failed", { events: parsed.length, error });
    for (const { message, event } of parsed) {
      try {
        await history.record([event], before);
        message.ack();
      } catch (error: unknown) {
        logger.error("storing an ingest event failed", { id: event.id, kind: event.kind, error });
        message.retry();
      }
    }
  }
}

/** One container per image: its jobs wait in its memory and run one at a time. */
async function handOver(env: Env, lang: Lang, messages: Message<IngestJob>[]): Promise<void> {
  let outcomes: Outcome[];
  try {
    outcomes = await env.INGESTER.getByName(lang).route(
      lang,
      messages.map((message) => message.body),
    );
  } catch (error: unknown) {
    logger.error("starting ingest failed", { lang, docs: messages.map((message) => message.body.doc), error });
    for (const message of messages) message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    return;
  }
  messages.forEach((message, i) => {
    switch (outcomes[i]) {
      case "accepted":
      case "malformed":
        // Malformed: retrying won't help
        message.ack();
        break;
      case "failed":
      case undefined:
        message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
        break;
    }
  });
}
