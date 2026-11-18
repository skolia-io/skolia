resource "cloudflare_r2_bucket" "documents" {
  account_id = var.account_id
  name       = "skolia-documents${local.suffix}"
  location   = local.location
}

resource "cloudflare_d1_database" "skolia" {
  account_id            = var.account_id
  name                  = "skolia${local.suffix}"
  primary_location_hint = local.location
  read_replication      = { mode = "auto" }
}

# Each language's lexicon for flashcards, skolia-lexicon-pl[-env] (infra/load-lexicon.py
# loads it)
resource "cloudflare_d1_database" "lexicon" {
  for_each              = toset(local.langs)
  account_id            = var.account_id
  name                  = "skolia-lexicon-${each.key}${local.suffix}"
  primary_location_hint = local.location
  read_replication      = { mode = "auto" }
}

# The ingest Worker's job history (ingest/migrations), apart from skolia so that one
# stays small and the ingest Worker binds no user data
resource "cloudflare_d1_database" "ingest" {
  account_id            = var.account_id
  name                  = "skolia-ingest${local.suffix}"
  primary_location_hint = local.location
}

# What the ingest containers send as each job starts and ends: the ingest Worker puts them
# here (its IngestEvents entrypoint) and stores them in skolia-ingest
resource "cloudflare_queue" "ingest_events" {
  account_id = var.account_id
  queue_name = "skolia-ingest-events${local.suffix}"
}

# The consumer is the ingest Worker (skolia-ingest[-env]); wrangler attaches it.
resource "cloudflare_queue" "ingest" {
  account_id = var.account_id
  queue_name = "skolia-ingest${local.suffix}"
}

# The skolia Worker, its workers.dev subdomain and its custom domain are deployed by
# wrangler from api/wrangler.jsonc, which also applies its Durable Object migrations.
# Terraform made them before; these let it forget them without deleting them.
removed {
  from = cloudflare_workers_script.skolia
  lifecycle {
    destroy = false
  }
}

removed {
  from = cloudflare_workers_script_subdomain.skolia
  lifecycle {
    destroy = false
  }
}

removed {
  from = cloudflare_workers_custom_domain.apex
  lifecycle {
    destroy = false
  }
}

# Signs the skolia Worker's sessions and encrypts its OAuth tokens. just deploy-web passes
# it as a Worker secret.
resource "random_password" "better_auth_secret" {
  length  = 48
  special = false
}
