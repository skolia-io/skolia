import type { DocumentId, IngestHistory, IngestJobRecord, IngestRunId, Lang } from "@skolia/shared/api";
import type { Versions } from "@skolia/shared/schema";
import type { IngesterRpc, IngestParams } from "@skolia/ingest/rpc";
import type { IngestJobs, JobQueue } from "../../ports/ingest.ts";
import { log } from "@skolia/util/log";
import * as schemas from "@skolia/shared/schemas";

const logger = log("adapters");

/** Asks a language's ingest container for its jobs: the ingest Worker's Ingester
 * (ingest/src/main.ts), or a fake in the tests. */
export type JobsOf = (lang: Lang) => Promise<IngestJobs | null>;

const RUN_HASH_LENGTH = 12;

/** A run's name: the document, and a short hash of the bundle it's to make (none before ingest
 * has published its versions), so a run asked for twice is one run, and a new version is a
 * new one. */
export async function runId(doc: DocumentId, versions: Versions | null): Promise<IngestRunId> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(versions?.bundle ?? ""));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return schemas.IngestRunId.parse(`${doc}-${hash.slice(0, RUN_HASH_LENGTH)}`);
}

/** A run that has ended, and can be run again */
const ENDED: ReadonlySet<InstanceStatus["status"]> = new Set(["complete", "errored", "terminated", "unknown"]);

/** Runs of ingest: the ingest Worker's IngestWorkflow (ingest/src/workflow.ts) */
export class IngestRuns implements JobQueue {
  private readonly workflow: Workflow<IngestParams>;
  private readonly jobsOf: JobsOf;

  constructor(workflow: Workflow<IngestParams>, jobsOf: JobsOf) {
    this.workflow = workflow;
    this.jobsOf = jobsOf;
  }

  async start(doc: DocumentId, lang: Lang, versions: Versions | null): Promise<void> {
    const id = await runId(doc, versions);
    try {
      await this.workflow.create({ id, params: { doc, lang } });
      return;
    } catch (error: unknown) {
      if (!String(error).includes("instance.already_exists")) {
        logger.error("starting a run of ingest failed", { doc, lang, run: id, error });
        throw error;
      }
    }
    const instance = await this.workflow.get(id);
    const { status } = await instance.status();
    if (!ENDED.has(status)) {
      logger.info("a run of ingest is under way", { doc, lang, run: id, status });
      return;
    }
    logger.info("running ingest again", { doc, lang, run: id, status });
    await instance.restart();
  }

  async jobs(lang: Lang): Promise<IngestJobs | null> {
    try {
      return await this.jobsOf(lang);
    } catch (error: unknown) {
      // The ingest Worker not deployed or not answering: a summary without its place
      logger.error("asking ingest for its jobs failed", { lang, error });
      return null;
    }
  }
}

export class RpcIngestHistory implements IngestHistory {
  private readonly ingester: DurableObjectNamespace<IngesterRpc>;

  constructor(ingester: DurableObjectNamespace<IngesterRpc>) {
    this.ingester = ingester;
  }

  recent(limit: number): Promise<readonly IngestJobRecord[]> {
    return this.ingester.getByName("history").recent(limit);
  }
}
