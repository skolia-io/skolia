-- What CI has built and deployed, for its deploy plan. A package's key is a hash of Nix outputs,
-- which nix eval gives without building anything, so a build or deployment whose key has a
-- row needn't be done again. Both tables only grow: a row is never changed or deleted.

-- A build, made once for every environment: an ingest image (image-<lang>), in the
-- registry, or the skolia Worker (worker), in Cachix. Going back to an earlier key builds
-- nothing.
CREATE TABLE build (
  id INTEGER PRIMARY KEY,
  package TEXT NOT NULL,
  key TEXT NOT NULL,
  built_at TEXT NOT NULL CHECK (built_at IS strftime('%Y-%m-%dT%H:%M:%fZ', built_at))
) STRICT;

CREATE INDEX build_package_key ON build (package, key);

-- A deployment of a package (ingest, lexicon, web) to an environment (staging, production,
-- pr-N). What an environment serves is each package's last row; key is null when nothing
-- is, as after a preview's teardown.
CREATE TABLE deployment (
  id INTEGER PRIMARY KEY,
  env TEXT NOT NULL,
  package TEXT NOT NULL,
  key TEXT,
  deployed_at TEXT NOT NULL CHECK (deployed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', deployed_at))
) STRICT;

CREATE INDEX deployment_env_package ON deployment (env, package, id);

CREATE TRIGGER build_no_update BEFORE UPDATE ON build BEGIN SELECT RAISE(ABORT, 'build only grows'); END;
CREATE TRIGGER build_no_delete BEFORE DELETE ON build BEGIN SELECT RAISE(ABORT, 'build only grows'); END;
CREATE TRIGGER deployment_no_update BEFORE UPDATE ON deployment BEGIN SELECT RAISE(ABORT, 'deployment only grows'); END;
CREATE TRIGGER deployment_no_delete BEFORE DELETE ON deployment BEGIN SELECT RAISE(ABORT, 'deployment only grows'); END;
