#!/usr/bin/env bash
# Pushes store paths, with their closures, to the Nix cache (niks3 at niks3.andyyu.io,
# read at https://nix-cache.andyyu.io) when NIKS3_AUTH_TOKEN is set, as in CI; does nothing
# otherwise. niks3 runs in a container that stops when idle, and the first request after
# that can fail while it starts, so requests are retried for 2 minutes.
#   cache-push.sh <store-path>...
set -euo pipefail
[ -n "${NIKS3_AUTH_TOKEN:-}" ] || exit 0
token=$(mktemp)
trap 'rm -f "$token"' EXIT
printf '%s' "$NIKS3_AUTH_TOKEN" >"$token"
niks3 push --server-url https://niks3.andyyu.io --auth-token-path "$token" --retry-timeout 2m "$@"
