output "service_url" {
  description = "Public URL of the staging API."
  value       = module.service.service_uri
}

output "migrate_job_name" {
  description = "Cloud Run migration job (CI updates + executes before deploys)."
  value       = module.service.migrate_job_name
}

output "sql_instance_name" {
  description = "Cloud SQL instance name."
  value       = module.data.sql_instance_name
}

output "redis_host" {
  description = "Memorystore private IP."
  value       = module.data.redis_host
}
