resource "cloudflare_r2_bucket" "inputs" {
  count      = var.env == "production" ? 1 : 0
  account_id = var.account_id
  name       = "skolia-inputs"
}
