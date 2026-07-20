output "state_bucket" {
  description = "GCS bucket backing the env stacks' remote state (matches envs/*/backend.tf)."
  value       = google_storage_bucket.tfstate.name
}

output "artifact_registry_url" {
  description = "Docker repository URL for CI pushes."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "workload_identity_provider" {
  description = "Full provider resource name for google-github-actions/auth's workload_identity_provider input."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_service_account" {
  description = "Email of the CI deployer SA (google-github-actions/auth's service_account input)."
  value       = google_service_account.deployer.email
}

output "admin_token_secret_id" {
  description = "Secret Manager id of the admin bootstrap token (value added by secrets.sh)."
  value       = google_secret_manager_secret.admin_token.secret_id
}
