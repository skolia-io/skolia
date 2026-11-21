#!/usr/bin/env bash
# Local end to end: wrangler dev with all four Workers, the ingest containers and empty local
# D1, R2 and queue, each language's lexicon sample (as a preview has) loaded, then the
# end-to-end tests (e2e/tests) and the curated texts' sync (api/src/sync-curated.ts, twice: the second run must find
# nothing to do) against it. Needs Docker, the reader build and the ingest images (just
# images). Port 8787 must be free: api/.env points the containers at it.
# usage: e2e.sh <lang>...
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "usage: e2e.sh <lang>..." >&2
  exit 2
fi
# Runs in api/, whose .env and wrangler state wrangler dev uses
api=$(cd "$(dirname "$0")/../api" && pwd)
cd "$api"
state=.wrangler/e2e
log=.wrangler/e2e.log
port=8787

rm -rf "$state"
d1() {
  pnpm exec wrangler d1 "$@" --local --persist-to "$state" --env dev >/dev/null
}
d1 migrations apply DB
for lang in "$@"; do d1 migrations apply "LEXICON_$(tr a-z A-Z <<<"$lang")" -c ../lexicon/wrangler.jsonc; done
d1 migrations apply INGEST_DB -c ../ingest/wrangler.jsonc
just load-lexicon local --sample 3000 --persist-to "$api/$state"

pnpm exec wrangler dev -c wrangler.jsonc -c wrangler.internal.jsonc -c ../ingest/wrangler.jsonc -c ../lexicon/wrangler.jsonc --env dev --persist-to "$state" --port "$port" --show-interactive-dev-session=false >"$log" 2>&1 &
dev=$!
stop_dev() {
  local status=$?
  kill "$dev" 2>/dev/null || true
  wait "$dev" 2>/dev/null || true
  if [ "$status" -ne 0 ]; then echo "See api/$log for the Worker logs" >&2; fi
}
trap stop_dev EXIT

until curl -fs -o /dev/null "http://localhost:$port/api/documents"; do
  if ! kill -0 "$dev" 2>/dev/null; then
    echo "wrangler dev exited; see api/$log" >&2
    exit 1
  fi
  sleep 2
done

SYNC_CURATED_API_KEY=$(openssl rand -hex 32)
export SYNC_CURATED_API_KEY
just d1-sql local api/src/sync-curated-key.ts "$api/$state"
just e2e-tests local "http://localhost:$port" dev "$api/$state"
node src/sync-curated.ts "http://localhost:$port" ../curated
node src/sync-curated.ts "http://localhost:$port" ../curated --check
