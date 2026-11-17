variable "alert_email" {
  type        = string
  description = "Address that gets the Usage Based Billing emails."
}

locals {
  usage_alerts = {
    worker_requests                 = { name = "Workers requests", limit = 11000000 }
    worker_standard_cpu_ms          = { name = "Workers CPU ms", limit = 33000000 }
    worker_durable_objects_requests = { name = "Durable Objects requests", limit = 1100000 }
    worker_durable_objects_duration = { name = "Durable Objects duration (GB-s)", limit = 440000 }
    r2_storage                      = { name = "R2 storage (bytes)", limit = 11000000000 }
    r2_class_a_operations           = { name = "R2 class A operations", limit = 1100000 }
    r2_class_b_operations           = { name = "R2 class B operations", limit = 11000000 }
    d1_rows_read                    = { name = "D1 rows read", limit = 27500000000 }
    d1_rows_written                 = { name = "D1 rows written", limit = 55000000 }
    queues_standard_operations      = { name = "Queues operations", limit = 1100000 }
  }
}

resource "cloudflare_notification_policy" "usage" {
  for_each = local.usage_alerts

  account_id  = var.account_id
  name        = "skolia: ${each.value.name}"
  description = "Usage this billing cycle passed ${each.value.limit}, above the Workers Paid included amount."
  alert_type  = "billing_usage_alert"
  enabled     = true

  filters = {
    product = [each.key]
    limit   = [tostring(each.value.limit)]
  }

  mechanisms = {
    email = [{ id = var.alert_email }]
  }
}

# Made by the app's module with production, before this one: adopted, not made again
import {
  for_each = {
    d1_rows_read                    = "227ff8b240e54d7ea87d7f1eab1f307a"
    d1_rows_written                 = "ab8abb28b7c84333aaaf2da801725f86"
    queues_standard_operations      = "bca73c2b1dce449b8b4c0d0f9937cf10"
    r2_class_a_operations           = "6cdf1ab57a6c4d2da6809468c70c10b7"
    r2_class_b_operations           = "e1cf9c27b29a4df9bbc89b4bea520445"
    r2_storage                      = "cd4a07d7c41042c2ac1f0834d0732ab2"
    worker_durable_objects_duration = "e27cfd17b352406c85ad2c2b091d2ca7"
    worker_durable_objects_requests = "5454b92c48304d228b45dbeff3a55001"
    worker_requests                 = "dab331e4cc2246ed97b14541dc25ebe9"
    worker_standard_cpu_ms          = "842da22cab824a6fbd33148ea2e58ffa"
  }
  to = cloudflare_notification_policy.usage[each.key]
  id = "${var.account_id}/${each.value}"
}
