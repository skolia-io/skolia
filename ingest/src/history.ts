// The jobs the ingest containers ran, in skolia-ingest's D1 database (ingest/migrations):
// the ingest Worker stores the containers' events and serves history over RPC.
import type { IngestEvent, IngestJobRecord, Timestamp } from "@skolia/shared/api";
import * as schemas from "@skolia/shared/schemas";
import { prepare } from "@skolia/util/d1";
import { sql, type Sql } from "@skolia/util/sql";

const COLUMNS = sql`id, document_id AS doc, lang, image, accepted_at AS acceptedAt, started_at AS startedAt,
  finished_at AS finishedAt, outcome, error, chars, words, stages`;

function recentQuery(limit: number): Sql {
  return sql`SELECT ${COLUMNS} FROM ingest_job ORDER BY started_at DESC LIMIT ${limit}`;
}

/** started adds the row unless it's there; finished adds it whole, or fills in the result
 * of the one started added, so they can come in either order, and either twice */
function eventQuery(event: IngestEvent): Sql {
  const started = [event.id, event.doc, event.lang, event.image, event.acceptedAt, event.startedAt];
  switch (event.kind) {
    case "started":
      return sql`INSERT INTO ingest_job (id, document_id, lang, image, accepted_at, started_at)
        VALUES ${sql.tuple(started)} ON CONFLICT (id) DO NOTHING`;
    case "finished": {
      const result = [event.finishedAt, event.outcome, event.error, event.chars, event.words, JSON.stringify(event.stages)];
      return sql`INSERT INTO ingest_job (id, document_id, lang, image, accepted_at, started_at, finished_at, outcome, error, chars, words, stages)
        VALUES ${sql.tuple([...started, ...result])}
        ON CONFLICT (id) DO UPDATE SET finished_at = excluded.finished_at, outcome = excluded.outcome, error = excluded.error,
          chars = excluded.chars, words = excluded.words, stages = excluded.stages`;
    }
  }
}

function pruneQuery(before: Timestamp): Sql {
  return sql`DELETE FROM ingest_job WHERE started_at < ${before}`;
}

export class D1IngestHistory {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async recent(limit: number): Promise<readonly IngestJobRecord[]> {
    const { results } = await prepare(this.db, recentQuery(limit)).all();
    return results.map((row) => schemas.IngestJobRow.parse(row));
  }

  /** Stores the events, and deletes the jobs that started before `before`. */
  async record(events: readonly IngestEvent[], before: Timestamp): Promise<void> {
    await this.db.batch([...events.map((event) => prepare(this.db, eventQuery(event))), prepare(this.db, pruneQuery(before))]);
  }
}

/** An event a container POSTed (main.ts IngestEvents), sent on to be stored. One that
 * isn't an event is refused: sent again, it won't be. */
export async function receiveEvent(send: (event: IngestEvent) => Promise<void>, request: Request): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "not found" }, { status: 404 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "not JSON" }, { status: 400 });
  }
  const event = schemas.IngestEvent.safeParse(body);
  if (!event.success) return Response.json({ error: event.error.message }, { status: 400 });
  await send(event.data);
  return new Response(null, { status: 202 });
}

const SOME_TIME = "2026-11-17T00:00:00.000Z" as Timestamp;

/** D1IngestHistory's queries, for the test that checks each one uses an index. */
export const INGEST_QUERIES = {
  recent: recentQuery(50).text,
  prune: pruneQuery(SOME_TIME).text,
};
