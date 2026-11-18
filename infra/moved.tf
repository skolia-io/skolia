# The bucket before skolia-documents, made in North America: forgotten rather than destroyed,
# since Terraform can't delete a bucket with objects in it
removed {
  from = cloudflare_r2_bucket.blobs
  lifecycle {
    destroy = false
  }
}

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
