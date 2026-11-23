# just <recipe> [env]. CI runs the same recipes (.github/workflows/ci.yml). Deploy recipes
# need the credentials in infra/README.md. terraform and just come from flake.nix
# (nix develop).

set shell := ["bash", "-euo", "pipefail", "-c"]

# Each has its own lexicon database, LEXICON_{LANG} in lexicon-api/wrangler.template.jsonc (lib/ts/api.ts LANGS)
langs := "en fr pl"

_default:
    @just --list

# Typecheck and lint everything
check: (lint "api") (lint "e2e") (lint "ingest") (lint "lexicon-api") (lint "oauth-proxy") (lint "reader") (lint "lib/ts") (lint "util") (lint "analysis") (lint "lexicon") (lint "lib/py") (lint "terraform")

# One project's checks and tests, CI's check job for it: a workspace package's directory, analysis or terraform (infra/plan.py projects)
check-project project: (lint project) && (unit project)
    if [ {{ project }} = api ]; then just build; fi

# A project's format check, lints and types
[private]
lint project:
    #!/usr/bin/env bash
    set -euo pipefail
    case {{ project }} in
      analysis | lexicon | lib/py)
        cd {{ project }}
        uv run --locked ruff check .
        uv run --locked ruff format --check .
        uv run pyright
        # The infrastructure scripts' Ruff runs with the analysis's
        if [ {{ project }} = analysis ]; then
          uv run --locked ruff check ../infra/*.py
          uv run --locked ruff format --check ../infra/*.py
        fi
        ;;
      terraform)
        pnpm exec oxfmt --check infra
        terraform -chdir=infra fmt -check -recursive
        for dir in infra infra/shared infra/tokens; do
          TF_DATA_DIR=.terraform-validate terraform -chdir=$dir init -backend=false -input=false >/dev/null
          TF_DATA_DIR=.terraform-validate terraform -chdir=$dir validate
        done
        ;;
      *)
        pnpm exec oxfmt --check {{ project }} package.json .oxfmtrc.json .oxlintrc.json
        pnpm exec oxlint {{ project }}
        pnpm --filter ./{{ project }} run --if-present check
        case {{ project }} in api | lexicon-api) redocly lint {{ project }}/openapi.json ;; esac
        case {{ project }} in lexicon-api) infra/load-lexicon.py config local --check ;; esac
        ;;
    esac

# A project's tests; the API's need just build first
[private]
unit project:
    #!/usr/bin/env bash
    set -euo pipefail
    case {{ project }} in
      analysis | lexicon | lib/py) cd {{ project }} && uv run pytest -q ;;
      terraform) ;;
      *) pnpm --filter ./{{ project }} run --if-present test ;;
    esac

# Format everything just check checks the format of
fmt:
    pnpm exec oxfmt --write api e2e ingest lexicon-api oauth-proxy reader lib/ts util infra package.json .oxfmtrc.json .oxlintrc.json
    uv run --locked ruff format analysis lexicon lib/py infra/*.py
    terraform -chdir=infra fmt -recursive

# Lint a Rust crate or workspace, including tests and examples
[positional-arguments]
lint-rust manifest="Cargo.toml":
    cargo clippy --manifest-path "$1" --workspace --all-targets --all-features -- -D warnings -D clippy::pedantic

# Unit tests, and the built Worker's Durable Object in workerd
test: build (unit "api") (unit "e2e") (unit "ingest") (unit "lexicon-api") (unit "oauth-proxy") (unit "reader") (unit "lib/ts") (unit "util") (unit "analysis") (unit "lexicon") (unit "lib/py")

# Screenshots of the reader's pages (reader/screenshots) in Playwright's Linux image, so they come
# out the same on a Mac and in CI. --update-snapshots accepts what changed. --ipc=host, as
# https://playwright.dev/docs/docker recommends for Chromium, which runs out of memory otherwise.
[positional-arguments]
screenshot *args:
    pnpm --filter @skolia/reader build
    docker run --rm --ipc=host -e CI -v "$PWD:$PWD" -w "$PWD/reader" \
        mcr.microsoft.com/playwright:v$(node -p 'require("./reader/package.json").devDependencies["@playwright/test"]')-noble \
        node_modules/.bin/playwright test "$@"

# The reader and the API bundle (api/dist, for the workerd tests)
build:
    pnpm --filter @skolia/reader build
    pnpm --dir api exec wrangler deploy --dry-run --outdir dist --env dev

# Write the API's and the lexicon's OpenAPI specs (api/openapi.json, lexicon-api/openapi.json) from their routes;
# api/src/openapi.test.ts and lexicon-api/src/spec.test.ts fail until you do
openapi:
    node api/src/spec.ts
    node lexicon-api/src/spec.ts

# wrangler dev (all four Workers, the ingest container, local D1/R2/queue) and the reader's Vite server,
# with the curated texts in curated/ synced once the API is up
[parallel]
dev: dev-api dev-reader dev-sync-curated

# Waits up to 30 minutes for wrangler dev (dev-api builds the ingest images first), then just sync-curated local
dev-sync-curated:
    #!/usr/bin/env bash
    set -euo pipefail
    for _ in $(seq 900); do
      if curl -fs -o /dev/null http://localhost:8787/api/documents; then
        exec just sync-curated local
      fi
      sleep 2
    done
    echo "wrangler dev didn't come up on :8787; not syncing" >&2
    exit 1

# migrations apply has no flag to skip its confirmation; without a TTY on stdin it doesn't ask

# wrangler dev on :8787 with local state in api/.wrangler/state
[working-directory('api')]
dev-api: install images env-local
    pnpm --filter @skolia/reader build
    pnpm exec wrangler d1 migrations apply DB --local --env dev </dev/null
    for lang in {{ langs }}; do pnpm exec wrangler d1 migrations apply "LEXICON_$(tr a-z A-Z <<<"$lang")" -c ../lexicon-api/wrangler.jsonc --local --persist-to .wrangler/state --env dev </dev/null; done
    pnpm exec wrangler d1 migrations apply INGEST_DB -c ../ingest/wrangler.jsonc --local --persist-to .wrangler/state --env dev </dev/null
    just load-lexicon local
    pnpm exec wrangler dev -c wrangler.jsonc -c wrangler.internal.jsonc -c ../ingest/wrangler.jsonc -c ../lexicon-api/wrangler.jsonc --env dev --port 8787

# The Node packages, as pnpm-lock.yaml has them
install:
    pnpm install --frozen-lockfile

# api/.env.local, the dev Google OAuth client, from secrets/dev.env if it's missing. sops finds the
# age key through .envrc.
[working-directory('api')]
env-local:
    #!/usr/bin/env bash
    set -euo pipefail
    [ -f .env.local ] && exit
    if ! sops decrypt ../secrets/dev.env > .env.local.tmp; then
      rm -f .env.local.tmp
      echo "env-local: can't decrypt secrets/dev.env, so only API keys sign in; DEVELOP.md says how to get your age key added" >&2
      exit 0
    fi
    mv .env.local.tmp .env.local

# Vite on :5173, proxying /api to :8787
dev-reader: install
    pnpm --filter @skolia/reader dev --port 5173 --strictPort

# Build each language's ingest image with Nix and load it into Docker for wrangler dev
images:
    analysis/scripts/load_images.sh

# What a deploy would change in Terraform's resources (env: shared, staging, production or pr-<N>)
plan env:
    infra/tf.sh {{ env }} plan -input=false

# Apply D1 migrations, then PRAGMA optimize, which D1 recommends after a schema change: ANALYZE, with a
# limit, where an index lacks statistics or a table has grown or shrunk tenfold. Its mask is OPTIMIZE's
# (util/sqlite.ts), as the tests' (api/src/testing/harness.ts) and the API's nightly cron's
# (api/src/worker/crons.ts). The lexicon's databases are each made whole from a build (just load-lexicon).
migrate env:
    infra/wrangler.sh {{ env }} d1 migrations apply DB --remote
    infra/wrangler.sh {{ env }} d1 execute DB --remote --yes --command "PRAGMA optimize=0x10012"
    case {{ env }} in \
      pr-*) config=../ingest/wrangler.{{ env }}.json ;; \
      *) config=../ingest/wrangler.jsonc ;; \
    esac; \
    infra/wrangler.sh {{ env }} d1 migrations apply INGEST_DB -c "$config" --remote && \
    infra/wrangler.sh {{ env }} d1 execute INGEST_DB -c "$config" --remote --yes --command "PRAGMA optimize=0x10012"

# Build a local lexicon. Pass a lemma to look it up in the build.
[positional-arguments]
lexicon-cli lang *args:
    #!/usr/bin/env bash
    set -euo pipefail
    lang=$1
    shift
    analysis/scripts/fetch_inputs.sh "$lang"
    out=$(nix build --no-link --print-out-paths "./analysis#lexicon-$lang")
    if [ "$#" -eq 0 ]; then
      printf '%s\n' "$out/$lang.sqlite"
    else
      uv run --project lexicon --locked skolia-lexicon --db "$out/$lang.sqlite" "$@"
    fi

# Load each language's lexicon (staging, production, pr-N or local) from its Nix build, into a D1 database
# named for its rows, unless one already has them (infra/load-lexicon.py); just deploy-lexicon binds it.
# A preview gets each language's entries for wordfreq's 3,000 most common words (infra/load-lexicon.py --sample).
# A language whose build evaluates to a Nix output already loaded is skipped without building it.
# With CACHIX_AUTH_TOKEN set (CI), a build is pushed to Cachix, so the next environment substitutes it.
# flags go to infra/load-lexicon.py (e2e/e2e.sh: --sample, --persist-to).
load-lexicon env *flags:
    #!/usr/bin/env bash
    set -euo pipefail
    case {{ env }} in pr-*) sample="--sample 3000" ;; *) sample= ;; esac
    for lang in {{ langs }}; do
      build="./analysis#lexicon-$lang"
      out=$(nix eval --raw "$build.outPath")
      state=$(infra/load-lexicon.py state {{ env }} --lang "$lang" --built-from "$out" $sample {{ flags }})
      if [ "$state" = current ]; then echo "{{ env }}: $lang already has $out"; continue; fi
      out=$(nix build --no-link --print-out-paths "$build")
      if [ -n "${CACHIX_AUTH_TOKEN:-}" ]; then cachix push andyyu2004 "$out"; fi
      if [ {{ env }} != local ]; then infra/plan.py deploying {{ env }} lexicon; fi
      infra/load-lexicon.py load {{ env }} "$out/$lang.sqlite" --built-from "$out" $sample {{ flags }}
    done
    if [ {{ env }} != local ]; then infra/plan.py deployed {{ env }} lexicon; fi

# Record in skolia-ci that env now serves this checkout's package (infra/plan.py)
[private]
deployed env package:
    infra/plan.py deployed {{ env }} {{ package }}

# Record in skolia-ci that env's package is being deployed, so a deploy that fails part way is needed again
[private]
deploying env package:
    infra/plan.py deploying {{ env }} {{ package }}

# The account's resources that aren't any environment's (infra/shared/), then skolia-ci's tables
deploy-shared: (deploying "shared" "infra-shared") (apply "shared") migrate-ci && (deployed "shared" "infra-shared")

# skolia-ci's tables (infra/skolia-ci/migrations), after just apply shared made it
migrate-ci:
    pnpm --dir api exec wrangler d1 migrations apply DB --remote -c "$PWD/infra/skolia-ci/wrangler.jsonc"

# Terraform: an environment's storage, queue and ingest's R2 token; shared: the account's billing alerts, provider mirror, lexicon sources and CI's records (skolia-ci)
apply env:
    infra/tf.sh {{ env }} apply -input=false

# Storage, private API capabilities, ingest, the lexicon, then the public API: dependencies before callers
deploy env: (deploy-infra env) (deploy-internal env) (deploy-ingest env) (deploy-lexicon env) (deploy-web env)

# Terraform, then D1 migrations; for a preview, its wrangler configs in between
deploy-infra env: (deploying env "infra") (apply env) && (migrate env) (deployed env "infra")
    case {{ env }} in pr-*) infra/preview.py config {{ env }} ;; esac

# Private API capabilities have no ingest binding, so fresh previews have no deploy cycle.
deploy-internal env:
    #!/usr/bin/env bash
    set -euo pipefail
    config="$PWD/api/wrangler.internal.jsonc"
    case {{ env }} in
      pr-*)
        config="$PWD/api/wrangler.internal.{{ env }}.json"
        [ -f "$config" ] || infra/preview.py config {{ env }}
        ;;
    esac
    infra/plan.py deploying {{ env }} internal
    infra/wrangler.sh {{ env }} deploy -c "$config"
    infra/plan.py deployed {{ env }} internal

# The lexicon Worker (lexicon-api/): its public API, and the LexiconService the skolia Worker binds, so before it.
# Bound to the databases just load-lexicon loaded this checkout's builds into (lexicon-api/wrangler.template.jsonc).
deploy-lexicon env:
    #!/usr/bin/env bash
    set -euo pipefail
    case {{ env }} in pr-*) sample="--sample 3000" ;; *) sample= ;; esac
    infra/plan.py deploying {{ env }} lexicon-worker
    infra/load-lexicon.py config {{ env }} $sample
    pnpm --dir lexicon-api exec wrangler deploy -c wrangler.{{ env }}.jsonc --env {{ env }}
    infra/plan.py deployed {{ env }} lexicon-worker

# The skolia Worker (reader and API) with wrangler, with Terraform's BETTER_AUTH_SECRET and, if set,
# GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and OAUTH_PROXY_SECRET from the environment (GitHub's, in CI) as its secrets.
# It uploads the Worker Nix builds (flake.nix skolia-worker), from Cachix if CI's build-web put it there.
# It records what it deployed (infra/plan.py), which CI skips a deploy for; a changed secret needs a deploy by hand.
deploy-web env:
    #!/usr/bin/env bash
    set -euo pipefail
    # What /api/version and the reader's About page show
    version=$(infra/plan.py version)
    out=$(nix build --no-link --print-out-paths .#skolia-worker)
    dir=$(mktemp -d)
    trap 'rm -rf "$dir"' EXIT
    # JSON: wrangler expands $ in a dotenv file
    infra/tf.sh {{ env }} output -raw better_auth_secret | jq -Rn '{BETTER_AUTH_SECRET: input}
      + ({GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET, OAUTH_PROXY_SECRET: env.OAUTH_PROXY_SECRET} | with_entries(select((.value // "") != "")))' > "$dir/secrets.json"
    # wrangler looks for its config beside a script it's given
    case {{ env }} in
      pr-*) config=wrangler.{{ env }}.json; [ -f "api/$config" ] || infra/preview.py config {{ env }} ;;
      *) config=wrangler.jsonc ;;
    esac
    infra/plan.py deploying {{ env }} web
    infra/wrangler.sh {{ env }} deploy "$out/worker/main.js" -c "$config" --no-bundle --assets "$out/assets" --var "VERSION:$version" \
      --secrets-file "$dir/secrets.json"
    infra/plan.py deployed {{ env }} web

# The previews' Google sign-in (oauth-proxy/), with GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
# and OAUTH_PROXY_SECRET from the environment (the oauth-proxy GitHub environment's, in CI) as its secrets
deploy-oauth-proxy:
    #!/usr/bin/env bash
    set -euo pipefail
    dir=$(mktemp -d)
    trap 'rm -rf "$dir"' EXIT
    jq -n '{GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET, OAUTH_PROXY_SECRET: env.OAUTH_PROXY_SECRET}
      | if any(.[]; (. // "") == "") then error("GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and OAUTH_PROXY_SECRET must be set") end' > "$dir/secrets.json"
    infra/plan.py deploying shared oauth-proxy
    (cd oauth-proxy && pnpm exec wrangler deploy --env production --secrets-file "$dir/secrets.json")
    infra/plan.py deployed shared oauth-proxy

# Build, push and deploy the ingest container
deploy-ingest env:
    infra/deploy-ingest.sh {{ env }}

# Request a warm-up of the deployed ingest containers and return once it is queued.
[private]
[positional-arguments]
warm-ingest env:
    #!/usr/bin/env bash
    set -euo pipefail
    workflow=skolia-ingest
    if [ "$1" != production ]; then workflow="$workflow-$1"; fi
    infra/wrangler.sh "$1" workflows trigger "$workflow" '{"warm":true}'

# Run e2e/tests against fresh local state (Docker) or against a deployed environment.
e2e env="local":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ {{ env }} = local ]; then
      just install build images
      exec e2e/e2e.sh {{ langs }}
    fi
    just e2e-tests {{ env }} "$(just url {{ env }})" "$(infra/plan.py version)"
    infra/plan.py deployed {{ env }} e2e

[private]
[positional-arguments]
e2e-tests env url version persist="":
    #!/usr/bin/env bash
    set -euo pipefail
    export E2E_URL="$2" E2E_VERSION="$3"
    node e2e/tests/ready.ts
    E2E_RUN_ID=$(openssl rand -hex 16)
    E2E_API_KEY=$(openssl rand -hex 32)
    E2E_USER_KEY=$(openssl rand -hex 32)
    export E2E_RUN_ID E2E_API_KEY E2E_USER_KEY
    trap 'E2E_KEYS_ACTION=cleanup just d1-sql "$1" api/src/e2e-keys.ts "$4" || exit 1' EXIT
    started=$SECONDS
    just d1-sql "$1" api/src/e2e-keys.ts "$4"
    echo "Provisioned e2e credentials in $((SECONDS - started))s"
    node --test --test-concurrency=4 e2e/tests/*.test.ts

# Make the curated user's documents match curated/ (api/src/sync-curated.ts); with --check, only list what that takes.
# A preview gets 5 of the texts (--sample), spread over languages, kinds and annotations.
# Writes a new API key for the curated user to the environment's D1 first (api/src/sync-curated-key.ts).
sync-curated env *flags:
    #!/usr/bin/env bash
    set -euo pipefail
    url=$(just url {{ env }})
    SYNC_CURATED_API_KEY=$(openssl rand -hex 32)
    export SYNC_CURATED_API_KEY
    case "{{ env }} {{ flags }}" in local* | *--check*) ;; *) infra/plan.py deploying {{ env }} curated ;; esac
    just d1-sql {{ env }} api/src/sync-curated-key.ts
    case {{ env }} in pr-*) sample="--sample 5" ;; *) sample= ;; esac
    node api/src/sync-curated.ts "$url" curated $sample {{ flags }}
    case "{{ env }} {{ flags }}" in local* | *--check*) ;; *) infra/plan.py deployed {{ env }} curated ;; esac

# The environment's URL
[private]
url env:
    #!/usr/bin/env bash
    case {{ env }} in
      local) echo http://localhost:8787 ;;
      production) echo https://skolia.io ;;
      staging) echo https://staging.skolia.io ;;
      *) infra/preview.py url {{ env }} ;;
    esac

# Runs the SQL a script prints (its API keys) on the environment's D1. --command, not --file:
# a file goes through D1's import, which refuses every other query meanwhile, such as the
# end-to-end tests' while sync-curated writes its key
[private]
[positional-arguments]
d1-sql env script persist="":
    #!/usr/bin/env bash
    set -euo pipefail
    sql=$(node "$2")
    if [ "$1" = local ]; then
      pnpm --dir api exec wrangler d1 execute DB --local --env dev ${3:+--persist-to "$3"} --command "$sql" >/dev/null
    else
      infra/wrangler.sh "$1" d1 execute DB --remote --yes --command "$sql" >/dev/null
    fi

# Add infra/.terraform.lock.hcl's providers to skolia-tf-providers, which CI installs them from (infra/terraformrc)
mirror-providers:
    infra/mirror-providers.py

# Delete a preview (pr-<N>): its Workers, container applications, storage, queue and Terraform state
teardown env:
    infra/teardown.sh {{ env }}
