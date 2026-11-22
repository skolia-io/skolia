-- Users have roles through bindings, and roles grant permissions. The code checks a
-- permission (PERMISSION_NAMES in shared/api.ts), never a role's name. A user who signs up
-- has no bindings; skolia.io's own accounts are bound to system.

CREATE TABLE permission (
  name TEXT NOT NULL PRIMARY KEY,
  description TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE role_permission (
  role TEXT NOT NULL REFERENCES role (name),
  permission TEXT NOT NULL REFERENCES permission (name),
  PRIMARY KEY (role, permission)
) STRICT, WITHOUT ROWID;

CREATE INDEX role_permission_permission_idx ON role_permission (permission);

CREATE TABLE role_binding (
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  role TEXT NOT NULL REFERENCES role (name),
  PRIMARY KEY (user_id, role)
) STRICT, WITHOUT ROWID;

CREATE INDEX role_binding_role_idx ON role_binding (role);

INSERT INTO permission (name, description) VALUES ('unlimited-rate', 'Not held to rate limits, such as on imports');

-- The end-to-end tests' importer and the curated texts'.
INSERT INTO role_permission (role, permission) VALUES ('system', 'unlimited-rate');

INSERT INTO role_binding (user_id, role) SELECT "id", role FROM "user" WHERE role = 'system';

-- A role is a binding now. SQLite drops the column once nothing indexes it, and dropping a
-- column keeps the table, so what references "user" (session, account, apikey,
-- user_document, role_binding) is untouched; rebuilding the table would cascade into them.
DROP INDEX user_role_idx;

ALTER TABLE "user" DROP COLUMN role;

-- Every user had standard unless they had system; having no binding means that now.
DELETE FROM role WHERE name = 'standard';
