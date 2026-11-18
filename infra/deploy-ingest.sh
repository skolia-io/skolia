#!/usr/bin/env bash
# Builds each language's ingest image with Nix (analysis/flake.nix), pushes it to
# Cloudflare's registry and deploys the ingest Worker with them:
#   deploy-ingest.sh build <lang>         build and push one language's image, for every
#                                          environment (CI runs one per language, in
#                                          parallel, before any deploy)
#   deploy-ingest.sh <env> deploy         deploy the ingest Worker with every language's
#                                          image, which must be in the registry
#   deploy-ingest.sh <env>                both, every language in turn
# env is staging, production or pr-N. deploy runs after tf.sh apply (the queue and bucket
# must exist). Each image is tagged with its Nix hash, which nix eval
# gives without building anything, so an image whose inputs are unchanged is neither
# rebuilt, pushed nor redeployed, and a push sends only the layers the registry lacks.
set -euo pipefail

usage="usage: deploy-ingest.sh build <lang> | deploy-ingest.sh <staging|production|pr-N> [deploy]"
env= mode= lang=
if [ "${1:-}" = build ]; then
  mode=build lang=${2:-}
elif [[ ${1:-} =~ ^(staging|production|pr-[0-9]+)$ ]]; then
  env=$1 mode=${2:-all}
else
  echo "$usage" >&2
  exit 2
fi
root=$(cd "$(dirname "$0")/.." && pwd)
wrangler() { "$root/infra/wrangler.sh" "$env" "$@"; }
# The registry is the account's, whichever environment; a preview's config may not be
# made yet when its images are built
registry_wrangler() { "$root/infra/wrangler.sh" account "$@"; }
cd "$root"

# One image per language, each named after it in ingest/wrangler.jsonc's images. CI's
# matrix in .github/workflows/ci.yml lists them too.
langs=(pl en fr)
repo=registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID

tag_of() { nix eval --raw "./analysis#ingest-$1.imageTag"; }

registry=
# Called in if conditions, where set -e doesn't apply: a failed listing exits by itself
in_registry() {
  if [ -z "$registry" ]; then
    registry=$(registry_wrangler containers images list --json) || exit
  fi
  jq -e --arg n "$1" --arg v "$2" '.[] | select(.name == $n) | .tags | index($v)' \
    <<<"$registry" >/dev/null
}

# The durable_object scheduling policy takes images pinned by digest. --no-tags: listing
# the repository's tags fails (Cloudflare's registry rejects skopeo's request).
digest_of() {
  local creds
  creds=$(registry_credentials --pull --expiration-minutes 10) || exit
  nix run ./analysis#skopeo -- inspect --no-tags --creds "v1:$creds" \
    --format "{{.Digest}}" "docker://$repo/$1"
}

# Fetched before skopeo starts, so a wrangler failure stops here instead of reaching the
# registry as an authentication error
registry_credentials() {
  registry_wrangler containers registries credentials registry.cloudflare.com "$@" | tail -n1
}

build_lang() {
  local lang=$1 name tag creds
  name=skolia-ingest-$lang
  tag=$(tag_of "$lang")
  if in_registry "$name" "$tag"; then
    echo "$name:$tag is already in the registry"
    return
  fi
  "$root/analysis/scripts/fetch_inputs.sh" "$lang"
  # Fails if the parser needs a model file the image doesn't have
  nix build -L --no-link "./analysis#checks.x86_64-linux.$lang"
  # With the credentials wrangler containers push would use (user v1). Cloudflare's
  # registry sometimes times out committing a large layer (on 2026-11-06 a 1 GB model layer
  # failed 3 times, then went through): skopeo retries.
  creds=$(registry_credentials --push --pull --expiration-minutes 60)
  nix run "./analysis#ingest-$lang.copyTo" -- --retry-times 5 \
    --format v2s2 --dest-creds "v1:$creds" "docker://$repo/$name:$tag"
  # Everything the next build needs but the models, which would fill the cache
  if [ -n "${CACHIX_AUTH_TOKEN:-}" ]; then
    nix build --no-link --print-out-paths "./analysis#cacheable-$lang" | cachix push andyyu2004
  fi
}

# Wrangler at times deploys the version but leaves the containers' settings half applied,
# and says running the same deploy again finishes it (skolia-io/tracking#71). It tells
# that error from others by the command-failed entry wrangler writes to its output file.
deploy_worker() {
  local config=$1 out=$2 attempt status attempts=3
  for ((attempt = 1; ; attempt++)); do
    : >"$out"
    if WRANGLER_OUTPUT_FILE_PATH=$out wrangler deploy -c "$config"; then
      return
    else
      status=$?
    fi
    if ((attempt == attempts)) || ! jq -e 'select(.type == "command-failed")
      | .message | contains("were not fully applied")' "$out" >/dev/null; then
      exit "$status"
    fi
    echo "wrangler deploy left the container settings not fully applied (attempt $attempt of $attempts): retrying in 30s" >&2
    sleep 30
  done
}

deploy() {
  local lang tag digest images=() pair config out copies
  for lang in "${langs[@]}"; do
    tag=$(tag_of "$lang")
    if ! in_registry "skolia-ingest-$lang" "$tag"; then
      echo "skolia-ingest-$lang:$tag isn't in the registry: build it first" >&2
      exit 1
    fi
    digest=$(digest_of "skolia-ingest-$lang:$tag")
    if [[ ! $digest =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "no digest for skolia-ingest-$lang:$tag: $digest" >&2
      exit 1
    fi
    images+=("$lang=$repo/skolia-ingest-$lang@$digest")
  done

  # The committed config builds analysis/image/Dockerfile (for wrangler dev); deploy the
  # pushed images, each under its language's name in images
  config=$root/ingest/wrangler.deploy.jsonc
  out=$(mktemp)
  # Expanded now: the trap runs at exit, after deploy's locals are gone
  trap "rm -f '$config' '$out'" EXIT
  if [[ $env == pr-* ]]; then
    # A preview's config is JSON (infra/preview.py) and holds only the preview
    [ -f "$root/ingest/wrangler.$env.json" ] || "$root/infra/preview.py" config "$env" >&2
    jq --argjson image "$(jq -n '$ARGS.positional | map(split("=") | {(.[0]): .[1]}) | add' --args "${images[@]}")" '
      .containers |= map(.images |= with_entries(
        if $image[.key] then .value = {image: $image[.key]}
        else error("no image for \(.key)") end))
    ' "$root/ingest/wrangler.$env.json" > "$config"
    copies=1
  else
    # Each language's image is on one line: "pl": { "dockerfile": ..., "build_vars": ... },
    awk -v images="$(IFS=,; echo "${images[*]}")" '
      BEGIN { n = split(images, pairs, ","); for (i = 1; i <= n; i++) { split(pairs[i], kv, "="); image[kv[1]] = kv[2] } }
      match($0, /^ *"[a-z]+": \{ "dockerfile": /) {
        match($0, /"[a-z]+"/); lang = substr($0, RSTART + 1, RLENGTH - 2)
        if (!(lang in image)) { print "no image for " lang > "/dev/stderr"; exit 1 }
        indent = $0; sub(/[^ ].*/, "", indent)
        print indent "\"" lang "\": { \"image\": \"" image[lang] "\" }" ($0 ~ /,$/ ? "," : "")
        next
      }
      { print }
    ' "$root/ingest/wrangler.jsonc" > "$config"
    # Production and staging
    copies=2
  fi
  for pair in "${images[@]}"; do
    if [ "$(grep -c "\"image\": \"${pair#*=}\"" "$config")" != "$copies" ]; then
      echo "expected ${pair#*=} $copies times in $config" >&2
      exit 1
    fi
  done

  deploy_worker "$config" "$out"
}

case $mode in
  build)
    if [[ " ${langs[*]} " != *" $lang "* ]]; then
      echo "deploy-ingest.sh: build takes one of: ${langs[*]}" >&2
      exit 2
    fi
    build_lang "$lang"
    ;;
  deploy) deploy ;;
  all)
    for lang in "${langs[@]}"; do build_lang "$lang"; done
    registry=
    deploy
    ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
