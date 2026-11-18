# infra

Terraform for what wrangler doesn't deploy: per environment, an R2 bucket, D1 databases (the app's, and a lexicon per language), and a queue; and once for the account (`infra/shared/`), billing usage alerts, the provider mirror, the lexicon's sources (`skolia-lexicon-sources`) and `skolia-ci`, a D1 of what CI has built and deployed (`build` and `deployment`, which only grow; `infra/skolia-ci/migrations`, applied by `just migrate-ci` after the shared apply). Both Workers are deployed with wrangler: `skolia` (reader + API, on workers.dev and skolia.io) from `api/wrangler.jsonc`, and `skolia-ingest` with its containers from `ingest/wrangler.jsonc`. Wrangler applies their Durable Object migrations; the provider resends the first migration on every update, which Cloudflare refuses ([cloudflare/terraform-provider-cloudflare#5701](https://github.com/cloudflare/terraform-provider-cloudflare/issues/5701)).

Account `22d39fac63e580576e28d9ed133ab62d` (skolia-io, owned by admin@skolia.io). Tokens in `pass` under `cloudflare/skolia-io/22d39fac63e580576e28d9ed133ab62d/`. Terraform comes from `flake.nix` (`nix develop`).

## One-time setup (done 2026-11-17)

1. Dashboard: enable R2 and subscribe to Workers Paid (Containers need it).
2. Dashboard: the bootstrap token, an account API token with Account API Tokens Edit and Workers R2 Storage Edit only, in `pass` as `tf-bootstrap`. It's used only for `infra/tf.sh tokens apply`, by hand.
3. The state bucket `skolia-tfstate`, made with the bootstrap token (Terraform can't create its own state bucket).
4. `infra/tf.sh tokens apply` with the bootstrap token: `tokens/` makes the deploy token, which everything else uses, CI and local runs alike. Store it with `infra/tf.sh tokens output -raw deploy_token | pass insert -m cloudflare/skolia-io/<account>/deploy`. A token made by a token can't make tokens, so nothing else here makes any.
5. skolia.io, moved from the account it was bought on (Registrar, Manage domain, Configuration), so its zone is on the account.
6. Dashboard (Notifications): a Billing Budget alert in dollars. `shared/alerts.tf` covers per-product usage, but Containers have no usage alert and the provider has no budget alert type.
7. Google Cloud project `skolia` (andyyu2004@gmail.com), Google Auth Platform: External audience, scopes `openid`, `userinfo.email`, `userinfo.profile`, authorised domain `skolia.io`. One OAuth client (Web application, no JavaScript origins) per environment, each in `pass` under `gcp/andyyu2004@gmail.com/<client>/{client-id,client-secret}`:

   | Client | Redirect URI |
   |---|---|
   | `skolia-dev` | `http://localhost:5173/api/auth/callback/google` |
   | `skolia-staging` | `https://staging.skolia.io/api/auth/callback/google` |
   | `skolia-prod` | `https://skolia.io/api/auth/callback/google` |
   | `skolia-preview` | `https://oauth-proxy.skolia.io/api/auth/callback/google` |

   The staging and production clients' id and secret are the `staging` and `production` GitHub environments' secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (see Deploy), which `just deploy-web` sets on the Worker with Terraform's `BETTER_AUTH_SECRET` (`random_password.better_auth_secret`). Without them nobody signs in with Google, so nobody can import; the end-to-end tests still can, with an API key (`just e2e`). Wrangler keeps secrets a deploy doesn't pass, so removing one from GitHub doesn't remove it from the Worker.

## Environments

| | production | staging | preview of pull request N |
|---|---|---|---|
| Env | `production` | `staging` | `pr-N` |
| URL | https://skolia.io | https://staging.skolia.io | https://skolia-pr-N.skolia-io.workers.dev |
| Names | `skolia`, `skolia-ingest` | `skolia-staging`, `skolia-ingest-staging` | `skolia-pr-N`, `skolia-ingest-pr-N` |
| Terraform state | `skolia.tfstate` | `skolia-staging.tfstate` | `skolia-pr-N.tfstate` |
| Wrangler | top level of `api/wrangler.jsonc`, `ingest/wrangler.jsonc` | `env.staging` | `api/wrangler.pr-N.json`, `ingest/wrangler.pr-N.json` (generated) |

All are on the same account. What there's one of per account (billing alerts, the provider mirror, the lexicon's sources, `skolia-ci`) is in `infra/shared/`, its own environment `shared` with its own state, `skolia-shared.tfstate`; CI's `deploy-shared` applies it from main when something a plan reads changed. `infra/tf.sh <env>` and `infra/wrangler.sh <env>` run terraform and wrangler for one environment. `api/wrangler.jsonc` names each D1 database and wrangler looks up its id. If the name isn't there, `wrangler deploy` creates it outside Terraform, so Terraform goes first (`deploy-infra`); `d1 migrations apply` fails instead.

A new environment: add it to the checks in `tf.sh`, `wrangler.sh` and `deploy-ingest.sh` and to `var.env`, add its `env` blocks, then `infra/tf.sh <env> apply`, and deploy.

### Previews

Each pull request from a branch of this repository gets a preview, `pr-N`, deployed and end-to-end tested on every push (`ci.yml`, job `deploy-preview`). Merging needs it to pass (`ci.yml`, job `mergeable`); a fork's pull request gets none and isn't held up, and nor does one that only changes content (curated texts, docs, Markdown; `.github/changes.py`). It is on workers.dev only. Its wrangler configs are made by `infra/preview.py config pr-N` from the `env.staging` blocks, with `-pr-N` names, its workers.dev URL and ingest containers that sleep after 10 s idle; `deploy-infra` makes them after Terraform, and `wrangler.sh` when they're missing. They're gitignored.

Closing the pull request tears the preview down (`just teardown pr-N`, `infra/teardown.sh`): the queue's consumer, the ingest Worker, its container applications (which `wrangler delete` leaves), the skolia Worker, the bucket's objects, `terraform destroy`, then the state object. Each step skips what's already gone, so it can be run again. Every night `sweep.yml` runs `infra/sweep.sh`, which finds previews by their resources' and state's names, tears down those whose pull request isn't open, and fails if any are left; `infra/sweep.sh -n` lists them without tearing them down.

Google sends a sign-in only to a redirect URI its client lists exactly, so a preview's own URL can't be one. Previews sign in through the OAuth proxy instead, `skolia-oauth-proxy` at https://oauth-proxy.skolia.io (`oauth-proxy/`, a package of its own on the API's better-auth, the workspace catalog's), the `skolia-preview` client's redirect URI, with Better Auth's oAuthProxy plugin: a preview's sign-in sends Google to the proxy with the preview's state, encrypted with `OAUTH_PROXY_SECRET`, which the proxy and the previews share; the proxy exchanges Google's code and redirects to the preview with the profile, encrypted too; and the preview makes the user and session in its own D1. The proxy keeps nothing, answers only `/api/auth/callback/google`, and redirects only to a preview's origin (`PREVIEWS`). `infra/preview.py` gives each preview its URL, `OAUTH_PROXY_URL`. It's deployed from main (`ci.yml`, job `deploy-oauth-proxy`; `just deploy-oauth-proxy`), so a pull request that changes how it works signs in on its preview only once it's merged. Anyone with a Google account can sign in on a preview, and import.

### Container usage

`infra/container-usage.py [--since DATE] [--until DATE]` prints the containers' memory use (GiB-seconds, what Cloudflare bills; 25 GiB-hours a month are free) per environment and per day, by default for this month. Torn-down previews show as `deleted`. Most of it is deploys': each one's end-to-end tests and curated sync start a container per language, which stays up `SLEEP_AFTER` (`ingest/src/main.ts`) once idle.

## Credentials

```fish
set -x CLOUDFLARE_ACCOUNT_ID 22d39fac63e580576e28d9ed133ab62d
set -x CLOUDFLARE_API_TOKEN (pass show cloudflare/skolia-io/$CLOUDFLARE_ACCOUNT_ID/deploy)
set -x TF_VAR_alert_email andyyu2004@gmail.com
```

The state bucket's S3 credentials are the token's own, which `tf.sh` works out: its id (`tokens/verify`) and the SHA-256 of its value.

## Deploy

A push to main deploys staging and runs the end-to-end tests against it (`api/src/e2e.ts`), through the API: in each language it imports a new text and waits until it's ready, and meanwhile checks auth, both languages' lexicon entries, and a new user's cards (add a word, review it, mark it known). Production deploys are tested the same way. It writes two API keys to D1 first (`api/src/e2e-keys.ts`): the system user's, which imports privately, so its two texts per deploy stay out of the library; and a new user's, `e2e-<time>`, whose cards start empty (the last run's user is deleted). `deploy-web` waits for `load-lexicon`, since the journeys read the lexicon. After `deploy-web`, two jobs run side by side: `e2e`, the tests, and `sync-curated` (`sync-curated.yml`), where `just sync-curated <env>` makes the library's curated texts match `curated/`, fetching those whose kind names a source (`api/src/curated-kinds.ts`): it imports them publicly as the curated user, a system user, with its own key (`api/src/sync-curated-key.ts`), updates their titles and licences, and deletes the curated user's texts that are no longer there (`just sync-curated <env> --check` lists what it would do). Pushing a `v*` tag on a commit in main deploys staging, then production once staging passes (`git tag v0.1.0 && git push origin v0.1.0`; `.github/workflows/ci.yml`, `deploy.yml`). The ingest Worker is deployed before the skolia Worker, since it consumes the queue the skolia Worker feeds: an API that sends a new kind of job never goes live before the ingest that handles it. Rolling back goes the other way: the skolia Worker first. Every deploy runs `deploy-ingest`: each language's image (`skolia-ingest-{lang}`) is tagged with its Nix hash, so it's built and pushed only when that tag isn't in the registry yet, and wrangler leaves an unchanged image deployed as it is. Pull requests get a `terraform plan` for staging and production (Terraform's resources only, not the Workers). GitHub needs:

- variable `CLOUDFLARE_ACCOUNT_ID`
- secrets `CLOUDFLARE_API_TOKEN` (the deploy token above), `ALERT_EMAIL`, `CACHIX_AUTH_TOKEN`
- in the `staging` and `production` environments, secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (the OAuth clients above)
- in the `preview` and `oauth-proxy` environments, the `skolia-preview` client's `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and the same `OAUTH_PROXY_SECRET`
- environments `staging`, `production`, `preview` (every pull request's) and `oauth-proxy`

Not every change deploys. CI's `changes` job (`.github/changes.py`) sorts a run by the files it changes, into three outputs:

- `deploy`: false only if every file is content, meaning `curated/`, `docs/` or Markdown, none of which goes into a build. CI then skips `check`, the screenshots, image builds, plans and deploys. A tag, a manual run, or a push it can't compare with its parent always deploys.
- `curated`: true if a curated text in `curated/` changed, a subset of content. With `deploy` false, CI checks only that the files parse as their kind (`check-curated`, `api/src/curated.test.ts`; a text fetched from its source is checked when the sync fetches it) and runs `just sync-curated` (`.github/workflows/sync-curated.yml`): against staging on a push to main, and against a pull request's preview if an earlier push deployed one. Production gets them at the next tag.
- `infra`: true if something a Terraform plan reads changed (`infra/`, the flake, the justfile, `.github/`). Pull requests run `plan-infra` only then.

| Change | `deploy` | `curated` | Runs |
|---|---|---|---|
| curated texts only | false | true | check-curated, sync-curated |
| docs or Markdown only | false | false | nothing but `changes` and `mergeable` |
| texts and code | true | true | everything (the deploy syncs) |
| code | true | false | everything; `plan-infra` only if `infra` |

`check` is a required check and a skipped job counts as passing, so `mergeable` fails when `check` should have run and didn't pass, or when `check-curated` failed.

CI installs Terraform's providers from the public R2 bucket `skolia-tf-providers` (`infra/shared/mirror.tf`) through `infra/terraformrc`, since the registry sends Terraform to GitHub's releases, which time out for unauthenticated requests at times. CI's `mirror-providers` job (`infra/mirror-providers.py`, also `just mirror-providers`) runs before `check` and adds whatever in `.terraform.lock.hcl` the mirror is missing, downloading GitHub's zips with a token; a zip whose hash isn't in the lock file is refused, and the lock file's hashes check what CI installs.

These, and `main`'s ruleset (pull requests only, through a merge queue that requires CI's `check` and `mergeable` jobs), are managed in Terraform in the dotfiles (`~/.dotfiles/terraform/github`), from `pass`.

By hand, with the credentials above, the same tasks CI runs:

```fish
just plan staging
just apply shared               # billing alerts, provider mirror, lexicon sources, skolia-ci
just migrate-ci                 # skolia-ci's tables
just deploy staging              # deploy-infra, deploy-ingest and deploy-web, in order; not load-lexicon
just deploy-infra staging        # terraform apply, D1 migrations
just deploy-ingest staging       # build, push and deploy the containers
just load-lexicon staging        # the flashcards' lexicon into D1, if its version is new; a preview gets each language's entries for wordfreq's 3,000 most common words
just deploy-web staging          # the skolia Worker (reader and API)
just e2e staging
just teardown pr-12              # previews only
```

`deploy-ingest` builds one image per language with Nix (`analysis/flake.nix`, `x86_64-linux`; on a Mac, Determinate Nix's Linux builder, DEVELOP.md): the models (fixed-output, pinned by hash), the venv from `uv.lock` (uv2nix), the lexicon from the inputs pinned in `inputs.sha256` (`fetch_inputs.sh <lang>` puts them in the store), and one layer per model, one for PyTorch, one for the other dependencies and one for the lexicon, as Cloudflare's registry times out committing a single 3 GB layer. Its tag is its Nix hash, which `nix eval` gives without building anything. It runs the parser check (`checks.x86_64-linux.{lang}`, which fails if the parser needs a model file the image doesn't have), pushes the image with skopeo (nix2container) with the credentials `wrangler containers push` would use, retrying, and sending only the layers the registry doesn't have, and deploys the ingest Worker with each image, pinned by the digest the registry gives (`skopeo inspect`), in place of `analysis/image/Dockerfile` under its language's name in the container's `images`. The container uses the `durable_object` scheduling policy: the ingest Worker hands each job to the `Ingester` named after its language's image, which starts a container with that image, so a deploy that changes an image sends new jobs to a new container while the old one finishes its jobs and stops. In CI each language's image is built on its own runner, in parallel before any deploy (`deploy-ingest.sh build <lang>`), pulling from and pushing to the `andyyu2004` Cachix cache everything but the models (`analysis#cacheable-{lang}`), which it downloads again when an image changes; one job then deploys the ingest Worker with all of them (`deploy-ingest.sh <env> deploy`).

A new language: its models and lexicon in `analysis/flake.nix`, an image named after it in `images` in `ingest/wrangler.jsonc` (both environments), the language in `langs` in `deploy-ingest.sh` and `load_images.sh` and in `langs` in the `justfile`, `local.langs` in `infra/variables.tf`, a `LEXICON_{LANG}` binding in `api/wrangler.jsonc` (both environments) and in the `build-ingest-image` matrix in `.github/workflows/ci.yml`, and its inputs in `fetch_inputs.sh`.
