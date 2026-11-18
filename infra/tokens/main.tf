data "cloudflare_account_api_token_permission_groups_list" "all" {
  account_id = var.account_id
}

locals {
  groups = {
    for g in data.cloudflare_account_api_token_permission_groups_list.all.result : g.name => g.id...
  }

  account_permissions = [
    "Workers Scripts Write",
    "Workers Containers Write",
    "Workers R2 Storage Write",
    "D1 Write",
    "Queues Write",
    "Notifications Write",
    "Workers KV Storage Read",
  ]

  zone_permissions = [
    "Zone Read",
    "Workers Routes Write",
  ]

  # Read-only, for looking into a deployment by hand: logs, Workers, Workflows, D1, R2
  debug_account_permissions = [
    "Workers Scripts Read",
    "Workers Observability Read",
    "Workers Tail Read",
    "Workers Containers Read",
    "Workers R2 Storage Read",
    "Workers KV Storage Read",
    "D1 Read",
    "Queues Read",
    "Notifications Read",
    "Account Analytics Read",
    "Account Settings Read",
  ]

  debug_zone_permissions = [
    "Zone Read",
    "Workers Routes Read",
    "Analytics Read",
  ]
}

resource "cloudflare_account_token" "deploy" {
  account_id = var.account_id
  name       = "skolia deploy"
  policies = [
    {
      effect            = "allow"
      permission_groups = [for name in local.account_permissions : { id = one(local.groups[name]) }]
      resources         = jsonencode({ "com.cloudflare.api.account.${var.account_id}" = "*" })
    },
    {
      effect            = "allow"
      permission_groups = [for name in local.zone_permissions : { id = one(local.groups[name]) }]
      resources = jsonencode({
        "com.cloudflare.api.account.${var.account_id}" = { "com.cloudflare.api.account.zone.*" = "*" }
      })
    },
  ]
}

output "deploy_token" {
  value     = cloudflare_account_token.deploy.value
  sensitive = true
}

resource "cloudflare_account_token" "debug" {
  account_id = var.account_id
  name       = "skolia debug"
  policies = [
    {
      effect            = "allow"
      permission_groups = [for name in local.debug_account_permissions : { id = one(local.groups[name]) }]
      resources         = jsonencode({ "com.cloudflare.api.account.${var.account_id}" = "*" })
    },
    {
      effect            = "allow"
      permission_groups = [for name in local.debug_zone_permissions : { id = one(local.groups[name]) }]
      resources = jsonencode({
        "com.cloudflare.api.account.${var.account_id}" = { "com.cloudflare.api.account.zone.*" = "*" }
      })
    },
  ]
}

output "debug_token" {
  value     = cloudflare_account_token.debug.value
  sensitive = true
}
