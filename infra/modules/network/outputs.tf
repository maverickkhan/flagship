output "network_id" {
  description = "VPC id, read THROUGH the PSA connection on purpose: consumers (Cloud SQL in modules/data) inherit a transitive dependency on the service networking connection. Terraform does not infer the PSA dependency from ip_configuration.private_network alone — without this chaining (plus the env root's explicit depends_on) the first apply races PSA setup and fails."
  value       = google_service_networking_connection.psa.network
}

output "network_name" {
  description = "VPC name."
  value       = google_compute_network.vpc.name
}

output "subnet_id" {
  description = "Subnet id for Cloud Run direct VPC egress."
  value       = google_compute_subnetwork.main.id
}

output "subnet_name" {
  description = "Subnet name."
  value       = google_compute_subnetwork.main.name
}

output "psa_connection_id" {
  description = "Service networking connection id (Cloud SQL private-IP prerequisite)."
  value       = google_service_networking_connection.psa.id
}
