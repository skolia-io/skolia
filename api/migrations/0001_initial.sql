-- Baseline for a new API database. Schema snapshots are checked in api/schema/.

CREATE TABLE "account" (
  -- Better Auth: provider identities and credentials.
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" TEXT CHECK ("accessTokenExpiresAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', "accessTokenExpiresAt")),
  "refreshTokenExpiresAt" TEXT CHECK ("refreshTokenExpiresAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', "refreshTokenExpiresAt")),
  "scope" TEXT,
  "password" TEXT,
  "createdAt" TEXT NOT NULL CHECK ("createdAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', "createdAt")),
  "updatedAt" TEXT NOT NULL CHECK ("updatedAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', "updatedAt"))
) STRICT;

CREATE INDEX "account_userId_idx" ON "account" ("userId");

CREATE TABLE "apikey" (
  -- Better Auth API key plugin.
  "id" TEXT NOT NULL PRIMARY KEY,
  "configId" TEXT NOT NULL,
  "name" TEXT,
  "start" TEXT,
  "referenceId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "prefix" TEXT,
  "key" TEXT NOT NULL,
  "refillInterval" INTEGER,
  "refillAmount" INTEGER,
  "lastRefillAt" TEXT CHECK ("lastRefillAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', "lastRefillAt")),
  "enabled" INTEGER,
  "rateLimitEnabled" INTEGER,
  "rateLimitTimeWindow" INTEGER,
  "rateLimitMax" INTEGER,
  "requestCount" INTEGER,
  "remaining" INTEGER,
  "lastRequest" TEXT CHECK ("lastRequest" IS strftime('%Y-%m-%dT%H:%M:%fZ', "lastRequest")),
  "expiresAt" TEXT CHECK ("expiresAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', "expiresAt")),
  "createdAt" TEXT NOT NULL CHECK ("createdAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', "createdAt")),
  "updatedAt" TEXT NOT NULL CHECK ("updatedAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', "updatedAt")),
  "permissions" TEXT,
  "metadata" TEXT
) STRICT;

CREATE INDEX "apikey_configId_idx" ON "apikey" ("configId");

CREATE INDEX "apikey_key_idx" ON "apikey" ("key");

CREATE INDEX "apikey_referenceId_idx" ON "apikey" ("referenceId");

CREATE TABLE attribution (
  id INTEGER PRIMARY KEY,
  licence TEXT NOT NULL,
  author TEXT CHECK (author != ''),
  source TEXT CHECK (source GLOB 'http://?*' OR source GLOB 'https://?*')
) STRICT;

CREATE UNIQUE INDEX attribution_credit_idx ON attribution (licence, ifnull(author, ''), ifnull(source, ''));

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

CREATE TABLE document (
  id TEXT NOT NULL PRIMARY KEY,
  lang TEXT NOT NULL,
  words INTEGER NOT NULL CHECK (words >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE document_status (
  -- No FK to document: import publishes queued status and starts ingest before
  -- inserting the document. A failed start must not leave a visible entry, and
  -- a fast run can publish its result before the document exists.
  document_id TEXT NOT NULL PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object')
) STRICT, WITHOUT ROWID;

CREATE TABLE "session" (
  -- Better Auth: signed-in sessions.
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" TEXT NOT NULL CHECK ("expiresAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', "expiresAt")),
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" TEXT NOT NULL CHECK ("createdAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', "createdAt")),
  "updatedAt" TEXT NOT NULL CHECK ("updatedAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', "updatedAt")),
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
) STRICT;

CREATE INDEX "session_userId_idx" ON "session" ("userId");

CREATE TABLE role (
  name TEXT NOT NULL PRIMARY KEY
) STRICT, WITHOUT ROWID;

CREATE TABLE tag (
  kind TEXT NOT NULL CHECK (kind GLOB '[a-z]*' AND kind NOT GLOB '*[^a-z0-9-]*' AND length(kind) <= 32),
  value TEXT NOT NULL CHECK (value GLOB '[A-Za-z0-9]*' AND value NOT GLOB '*[^A-Za-z0-9.+-]*' AND length(value) <= 32),
  description TEXT,
  position INTEGER NOT NULL,
  PRIMARY KEY (kind, value),
  UNIQUE (kind, position)
) STRICT, WITHOUT ROWID;

CREATE TABLE "user" (
  -- Better Auth identity; role is Skolia's application-specific field.
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" TEXT NOT NULL CHECK ("createdAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', "createdAt")),
  "updatedAt" TEXT NOT NULL CHECK ("updatedAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', "updatedAt")),
  role TEXT NOT NULL DEFAULT 'standard' REFERENCES role (name)
) STRICT;

CREATE INDEX user_role_idx ON "user" (role);

CREATE TABLE user_document (
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES document (id),
  title TEXT NOT NULL,
  imported_at TEXT NOT NULL CHECK (imported_at IS strftime('%Y-%m-%dT%H:%M:%fZ', imported_at)),
  visibility TEXT NOT NULL,
  attribution_id INTEGER NOT NULL REFERENCES attribution (id),
  annotations_count INTEGER NOT NULL DEFAULT 0 CHECK (annotations_count >= 0),
  PRIMARY KEY (user_id, document_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX user_document_document_idx ON user_document (document_id);

CREATE INDEX user_document_public_idx ON user_document (user_id, document_id) WHERE visibility = 'public';

CREATE TABLE user_document_annotation (
  user_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  id TEXT NOT NULL,
  start INTEGER NOT NULL CHECK (start >= 0),
  "end" INTEGER NOT NULL CHECK ("end" > start),
  kind TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
  attribution_id INTEGER NOT NULL REFERENCES attribution (id),
  added_at TEXT NOT NULL CHECK (added_at IS strftime('%Y-%m-%dT%H:%M:%fZ', added_at)),
  PRIMARY KEY (user_id, document_id, id),
  FOREIGN KEY (user_id, document_id) REFERENCES user_document (user_id, document_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX user_document_annotation_start_idx ON user_document_annotation (user_id, document_id, start, id);

CREATE TRIGGER user_document_annotation_added AFTER INSERT ON user_document_annotation
BEGIN
  UPDATE user_document SET annotations_count = annotations_count + 1
  WHERE user_id = NEW.user_id AND document_id = NEW.document_id;
END;

CREATE TRIGGER user_document_annotation_removed AFTER DELETE ON user_document_annotation
BEGIN
  UPDATE user_document SET annotations_count = annotations_count - 1
  WHERE user_id = OLD.user_id AND document_id = OLD.document_id;
END;

CREATE TABLE user_document_tag (
  user_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, document_id, kind),
  FOREIGN KEY (user_id, document_id) REFERENCES user_document (user_id, document_id) ON DELETE CASCADE,
  FOREIGN KEY (kind, value) REFERENCES tag (kind, value)
) STRICT, WITHOUT ROWID;

CREATE INDEX user_document_tag_value_idx ON user_document_tag (kind, value, user_id, document_id);

CREATE TABLE "verification" (
  -- Better Auth: verification values and expiry.
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" TEXT NOT NULL CHECK ("expiresAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', "expiresAt")),
  "createdAt" TEXT NOT NULL CHECK ("createdAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', "createdAt")),
  "updatedAt" TEXT NOT NULL CHECK ("updatedAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', "updatedAt"))
) STRICT;

CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

INSERT INTO role (name) VALUES ('standard'), ('system');

-- E2E and curated importers, and the tags available to importers.
INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt", role)
VALUES ('system', 'skolia.io', 'system@skolia.io', 0, NULL, '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z', 'system');

INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt", role)
VALUES ('curated', 'skolia.io', 'curated@skolia.io', 0, NULL, '2026-11-08T00:00:00.000Z', '2026-11-08T00:00:00.000Z', 'system');

INSERT INTO tag (kind, value, description, position) VALUES
  ('level', 'A0', 'Starter', 0),
  ('level', 'A1', 'Beginner', 1),
  ('level', 'A2', 'Elementary', 2),
  ('level', 'B1', 'Intermediate', 3),
  ('level', 'B2', 'Upper intermediate', 4),
  ('level', 'C1', 'Advanced', 5),
  ('level', 'C2', 'Proficient', 6),
  ('level', 'C3', 'Native', 7);
