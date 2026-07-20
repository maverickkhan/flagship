output "service_name" {
  description = "Cloud Run service name."
  value       = google_cloud_run_v2_service.api.name
}

output "service_uri" {
  description = "Public HTTPS URL of the API."
  value       = google_cloud_run_v2_service.api.uri
}

output "migrate_job_name" {
  description = "Cloud Run job that applies migrations (CI updates + executes it before each deploy)."
  value       = google_cloud_run_v2_job.migrate.name
}

output "api_service_account_email" {
  description = "API runtime SA email."
  value       = google_service_account.api.email
}

output "migrator_service_account_email" {
  description = "Migrator job SA email."
  value       = google_service_account.migrator.email
}
