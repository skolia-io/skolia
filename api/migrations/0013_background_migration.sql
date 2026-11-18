-- Schema changes stay in D1 migrations; background scripts only migrate data.
CREATE TABLE background_migration (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL,
  cursor TEXT,
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL CHECK (lease_expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at)),
  started_at TEXT NOT NULL CHECK (started_at IS strftime('%Y-%m-%dT%H:%M:%fZ', started_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  completed_at TEXT CHECK (completed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', completed_at))
) STRICT;
