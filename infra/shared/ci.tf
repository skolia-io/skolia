# What CI has built and deployed, so its deploy plan skips what's current. Its tables are infra/skolia-ci/migrations (just migrate-ci).
resource "cloudflare_d1_database" "ci" {
  account_id = var.account_id
  name       = "skolia-ci"
}
