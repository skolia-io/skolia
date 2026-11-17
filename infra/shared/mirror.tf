# Terraform's providers for CI (infra/terraformrc, infra/mirror-providers.py)
resource "cloudflare_r2_bucket" "tf_providers" {
  account_id = var.account_id
  name       = "skolia-tf-providers"
}

resource "cloudflare_r2_managed_domain" "tf_providers" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.tf_providers.name
  enabled     = true
}

output "tf_providers_mirror_url" {
  value = "https://${cloudflare_r2_managed_domain.tf_providers.domain}/"
}
