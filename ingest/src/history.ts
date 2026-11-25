// The jobs the ingest containers ran, in skolia-ingest's D1 database (ingest/migrations):
// each run of IngestWorkflow stores its job's attempts, and the ingest Worker serves the
// history over RPC.
import type { DocumentId, IngestHistory, IngestJobRecord, Lang, Timestamp } from "@skolia/shared/api";
import type { JobAttempt } from "@skolia/shared/schema";
import * as schemas from "@skolia/shared/schemas";
import { prepare } from "@skolia/util/d1";
import { sql, type Sql } from "@skolia/util/sql";

const COLUMNS = sql`id, document_id AS doc, lang, image, accepted_at AS acceptedAt, started_at AS startedAt,
  finished_at AS finishedAt, outcome, error, chars, words, stages`;

function recentQuery(limit: number): Sql {
  return sql`SELECT ${COLUMNS} FROM ingest_job ORDER BY started_at DESC LIMIT ${limit}`;
}

/** Adds the attempt unless it's there, so a run that records it twice records it once */
function attemptQuery(doc: DocumentId, lang: Lang, attempt: JobAttempt): Sql {
  const row = [
    attempt.id,
    doc,
    lang,
    attempt.image,
    attempt.acceptedAt,
    attempt.startedAt,
    attempt.finishedAt,
    attempt.outcome,
    attempt.error === null ? null : JSON.stringify(attempt.error),
    attempt.chars,
    attempt.words,
    JSON.stringify(attempt.stages),
  ];
  return sql`INSERT INTO ingest_job (id, document_id, lang, image, accepted_at, started_at, finished_at, outcome, error, chars, words, stages)
    VALUES ${sql.tuple(row)} ON CONFLICT (id) DO NOTHING`;
}

function pruneQuery(before: Timestamp): Sql {
  return sql`DELETE FROM ingest_job WHERE started_at < ${before}`;
}

export class D1IngestHistory implements IngestHistory {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async recent(limit: number): Promise<readonly IngestJobRecord[]> {
    const { results } = await prepare(this.db, recentQuery(limit)).all();
    return results.map((row) => schemas.IngestJobRow.parse(row));
  }

  /** Stores a job's attempts, and deletes the jobs that started before `before`. */
  async record(doc: DocumentId, lang: Lang, attempts: readonly JobAttempt[], before: Timestamp): Promise<void> {
    await this.db.batch([
      ...attempts.map((attempt) => prepare(this.db, attemptQuery(doc, lang, attempt))),
      prepare(this.db, pruneQuery(before)),
    ]);
  }
}

const SOME_TIME = "2026-11-17T00:00:00.000Z" as Timestamp;

/** D1IngestHistory's queries, for the test that checks each one uses an index. */
export const INGEST_QUERIES = {
  recent: recentQuery(50).text,
  prune: pruneQuery(SOME_TIME).text,
};
