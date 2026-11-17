#!/usr/bin/env bash
# terraform for one environment: tf.sh <tokens|shared|staging|production|pr-N> <terraform args...>
# Each environment has its own state (skolia.tfstate, skolia-staging.tfstate,
# skolia-pr-12.tfstate) and init directory (.terraform-{env}). shared is the account's
# resources that aren't any environment's (shared/), in skolia-shared.tfstate; tokens is
# the account's API tokens (tokens/), applied with the bootstrap token. Needs
# CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (README.md). The state bucket's S3
# credentials are the token's: its id, and the SHA-256 of its value.
set -euo pipefail

env=${1:-}
if [[ ! $env =~ ^(tokens|shared|staging|production|pr-[0-9]+)$ ]]; then
  echo "usage: tf.sh <tokens|shared|staging|production|pr-N> <terraform args...>" >&2
  exit 2
fi
shift

cd "$(dirname "$0")"
export TF_DATA_DIR=.terraform-$env
export TF_VAR_account_id=${TF_VAR_account_id:-$CLOUDFLARE_ACCOUNT_ID}
case $env in
  tokens | shared) cd "$env" ;;
  *) export TF_VAR_env=$env ;;
esac

AWS_ACCESS_KEY_ID=$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify" | jq -er .result.id)
AWS_SECRET_ACCESS_KEY=$(printf %s "$CLOUDFLARE_API_TOKEN" | shasum -a 256 | cut -d' ' -f1)
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

key=skolia.tfstate
[ "$env" = production ] || key=skolia-$env.tfstate
if [ ! -f "$TF_DATA_DIR/terraform.tfstate" ]; then
  # readonly: a missing platform hash fails here instead of dirtying the checkout, which
  # the end-to-end tests' git describe would then report as -dirty
  terraform init -input=false -lockfile=readonly -backend-config="key=$key" \
    -backend-config="endpoints={s3=\"https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com\"}" >&2
fi
exec terraform "$@"
