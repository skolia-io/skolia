# The datasets the lexicon build reads (Kaikki's extracts, Walenty, Commons' recordings), as
# {sha256}-{name}.zst, pinned by analysis/inputs.sha256 (analysis/scripts/fetch_inputs.sh)
resource "cloudflare_r2_bucket" "lexicon_sources" {
  account_id = var.account_id
  name       = "skolia-lexicon-sources"
}
