# Moved to infra/shared/ (account-wide, made once): production forgets them without
# destroying them, and the shared module adopts them
removed {
  from = cloudflare_r2_bucket.tf_providers
  lifecycle {
    destroy = false
  }
}

removed {
  from = cloudflare_r2_managed_domain.tf_providers
  lifecycle {
    destroy = false
  }
}

removed {
  from = cloudflare_notification_policy.usage
  lifecycle {
    destroy = false
  }
}
