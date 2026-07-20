# Secret-id outputs carry depends_on on their version resources so consumers
# (Cloud Run in modules/service) cannot deploy before the secret has a
# resolvable "latest" version.

output "sql_instance_name" {
  description = "Cloud SQL instance name."
  value       = google_sql_database_instance.postgres.name
}

output "sql_connection_name" {
  description = "Cloud SQL connection name (project:region:instance)."
  value       = google_sql_database_instance.postgres.connection_name
}

output "sql_private_ip" {
  description = "Private IP of the Cloud SQL instance."
  value       = google_sql_database_instance.postgres.private_ip_address
}

output "redis_host" {
  description = "Memorystore host (private IP)."
  value       = google_redis_instance.cache.host
}

output "redis_port" {
  description = "Memorystore port."
  value       = google_redis_instance.cache.port
}

output "app_db_secret_id" {
  description = "Secret Manager id of the app (DML-only) DATABASE_URL."
  value       = google_secret_manager_secret.app_database_url.secret_id

  depends_on = [google_secret_manager_secret_version.app_database_url]
}

output "migrator_db_secret_id" {
  description = "Secret Manager id of the migrator (schema-owner) DATABASE_URL."
  value       = google_secret_manager_secret.migrator_database_url.secret_id

  depends_on = [google_secret_manager_secret_version.migrator_database_url]
}

output "redis_url_secret_id" {
  description = "Secret Manager id of the REDIS_URL (AUTH string embedded)."
  value       = google_secret_manager_secret.redis_url.secret_id

  depends_on = [google_secret_manager_secret_version.redis_url]
}
