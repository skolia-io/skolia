output "queue_id" {
  value = cloudflare_queue.ingest.queue_id
}

output "better_auth_secret" {
  value     = random_password.better_auth_secret.result
  sensitive = true
}
