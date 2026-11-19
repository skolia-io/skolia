#!/usr/bin/env bash
# Source this file and pass a function that applies the SQL from e2e-keys.ts.
run_e2e() (
  set -euo pipefail
  local apply_keys=$3
  local api
  api=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  export E2E_URL="$1" E2E_VERSION="$2"
  export E2E_CARD_CONCURRENCY="${E2E_CARD_CONCURRENCY:-3}"
  case "$E2E_CARD_CONCURRENCY" in
    1|2|3) ;;
    *) echo "E2E_CARD_CONCURRENCY must be 1, 2, or 3" >&2; exit 2 ;;
  esac
  node "$api/tests/e2e/ready.ts"

  E2E_RUN_ID=$(openssl rand -hex 16)
  E2E_API_KEY=$(openssl rand -hex 32)
  E2E_USER_KEY=$(openssl rand -hex 32)
  export E2E_RUN_ID E2E_API_KEY E2E_USER_KEY
  cleanup_e2e() {
    local status=$?
    trap - EXIT
    if ! E2E_KEYS_ACTION=cleanup "$apply_keys"; then
      echo "Could not remove e2e credentials for run $E2E_RUN_ID" >&2
      if [ "$status" -eq 0 ]; then status=1; fi
    fi
    exit "$status"
  }
  trap cleanup_e2e EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  local started=$SECONDS
  E2E_KEYS_ACTION=setup "$apply_keys"
  echo "Provisioned e2e credentials in $((SECONDS - started))s"
  node --test --test-concurrency=4 "$api"/tests/e2e/*.test.ts
)
