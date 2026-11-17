-- A job an ingest container ran, from the events it sent as it started and as it ended
-- (POST /api/ingest/events, stored by api/src/worker/ingest.ts). A row comes with either:
-- the result's columns are null until the job has finished, and stay null for one whose
-- container stopped first. The events can arrive in either order. retried: storage failed
-- and the job went back in line, to run again as another job. chars and words are null for
-- a job that failed before it read the text. stages is [{stage, ms}] in the order they
-- ran, only ever shown. No reference to the document: it's in another database, and an
-- edited curated text's old one is deleted. Rows that started more than ingest.ts's
-- HISTORY_DAYS ago are deleted as events come.
CREATE TABLE ingest_job (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  image TEXT NOT NULL,
  accepted_at TEXT NOT NULL CHECK (accepted_at IS strftime('%Y-%m-%dT%H:%M:%fZ', accepted_at)),
  started_at TEXT NOT NULL CHECK (started_at IS strftime('%Y-%m-%dT%H:%M:%fZ', started_at)),
  finished_at TEXT CHECK (finished_at IS strftime('%Y-%m-%dT%H:%M:%fZ', finished_at)),
  outcome TEXT CHECK (outcome IN ('ready', 'failed', 'retried')),
  error TEXT,
  chars INTEGER CHECK (chars >= 0),
  words INTEGER CHECK (words >= 0),
  stages TEXT CHECK (json_valid(stages) AND json_type(stages) = 'array'),
  CHECK ((finished_at IS NULL) = (outcome IS NULL) AND (finished_at IS NULL) = (stages IS NULL)),
  CHECK (outcome IS NOT NULL OR (error IS NULL AND chars IS NULL AND words IS NULL)),
  CHECK (error IS NULL OR outcome != 'ready')
) STRICT;

-- The jobs started most recently, and the oldest to delete
CREATE INDEX ingest_job_started_idx ON ingest_job (started_at);
