# Network layer: one VPC per environment (env-suffixed), a subnet for Cloud
# Run direct VPC egress, and Private Service Access (PSA) so Cloud SQL can
# attach a private IP.
#
# No ingress firewall rules on purpose: nothing inside the VPC listens
# publicly (Cloud SQL and Redis are reached over private peering, Cloud Run
# ingress terminates at Google's front end), and the VPC's implied
# deny-ingress covers the rest (PLAN §8).

terraform {
  required_version = ">= 1.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

locals {
  name = "${var.service}-${var.env}"
}

resource "google_compute_network" "vpc" {
  project                 = var.project_id
  name                    = local.name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "main" {
  project                  = var.project_id
  name                     = "${local.name}-subnet"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true
}

# Reserved internal range handed to Google's service-producer network, plus
# the peering itself — the prerequisite for Cloud SQL private IP.
resource "google_compute_global_address" "psa" {
  project       = var.project_id
  name          = "${local.name}-psa"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa.name]
}
