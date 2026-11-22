-- What each role lets its users do. The code checks a permission (PERMISSION_NAMES in
-- shared/api.ts), never a role's name; a role gets one with a row in role_permission.

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

INSERT INTO permission (name, description) VALUES ('unlimited-rate', 'Not held to rate limits, such as on imports');

-- skolia.io's own accounts: the end-to-end tests' importer and the curated texts'.
INSERT INTO role_permission (role, permission) VALUES ('system', 'unlimited-rate');
