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

# Each language's lexicon, skolia-lexicon-pl[-env], before each build had a database of its
# own (infra/load-lexicon.py makes them). Forgotten rather than destroyed, since the lexicon
# Worker binds them until it's deployed with its builds'; infra/gc-lexicon.py deletes them
# once no version of it does.
removed {
  from = cloudflare_d1_database.lexicon
  lifecycle {
    destroy = false
  }
}

# The ingest Worker's job history (ingest/migrations), apart from skolia so that one
# stays small and the ingest Worker binds no user data
resource "cloudflare_d1_database" "ingest" {
  account_id            = var.account_id
  name                  = "skolia-ingest${local.suffix}"
  primary_location_hint = local.location
}

# Unused: the ingest Worker's events, before each run recorded its job's attempts. Kept until
# every environment's ingest Worker no longer consumes it, since a queue with a consumer
# can't be deleted
resource "cloudflare_queue" "ingest_events" {
  account_id = var.account_id
  queue_name = "skolia-ingest-events${local.suffix}"
}

# Unused: the ingest jobs, before IngestWorkflow. Kept for the same reason
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
