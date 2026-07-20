# Data layer: Cloud SQL Postgres 16 (private IP only), Memorystore Redis
# (AUTH enabled), and the Secret Manager secrets Cloud Run consumes.

terraform {
  required_version = ">= 1.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

locals {
  name = "${var.service}-${var.env}"
}

# ---------------------------------------------------------------------------
# Cloud SQL — Postgres 16, private IP only
# ---------------------------------------------------------------------------

resource "google_sql_database_instance" "postgres" {
  project          = var.project_id
  name             = local.name
  region           = var.region
  database_version = "POSTGRES_16"

  # true only in production (envs/*/main.tf) so staging teardown stays one
  # command while the prod database survives a stray destroy.
  deletion_protection = var.deletion_protection

  settings {
    # PG16+ instances default to the Enterprise Plus edition, where
    # shared-core tiers like db-f1-micro are invalid — left unset, the first
    # apply fails. Pin the plain Enterprise edition explicitly (PLAN §8).
    edition = "ENTERPRISE"

    tier              = var.sql_tier
    availability_type = "ZONAL" # single region, no HA — stated non-goal
    disk_size         = 10
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled = false

      # var.network_id is read through the network module's PSA connection
      # output, so this reference carries a transitive dependency on Private
      # Service Access being ready. Terraform does NOT infer that dependency
      # from private_network alone — without the chaining (and the env root's
      # belt-and-braces `depends_on = [module.network]`) the first apply races
      # PSA setup and fails.
      private_network = var.network_id
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = true
    }
  }
}

resource "google_sql_database" "main" {
  project  = var.project_id
  instance = google_sql_database_instance.postgres.name
  name     = var.database_name
}

# ---------------------------------------------------------------------------
# SQL users — app (DML only) and migrator (schema owner)
# ---------------------------------------------------------------------------
# ADR: these random_password values — and the google_sql_user passwords and
# Secret Manager version payloads derived from them — are stored in Terraform
# state. Accepted trade-off for this exercise (PLAN §8 "Secrets policy"),
# mitigated by the state bucket being versioned and IAM-restricted to the
# operator identity only (see infra/bootstrap — the CI deployer SA has no
# state access at all). The production-grade alternative is Cloud SQL IAM
# database authentication or out-of-band user creation, as already done for
# the admin token (bootstrap/secrets.sh). Called out honestly in README.
#
# special = false keeps the passwords URL-safe so they embed in DATABASE_URL
# without percent-encoding.

resource "random_password" "app" {
  length  = 32
  special = false
}

resource "random_password" "migrator" {
  length  = 32
  special = false
}

# Privilege separation is enforced at the Postgres layer by migration SQL run
# as `migrator` (schema owner): `app` gets DML only, and INSERT/SELECT only on
# audit_logs — the grant that backs the audit-immutability claim (PLAN §3).
resource "google_sql_user" "app" {
  project  = var.project_id
  instance = google_sql_database_instance.postgres.name
  name     = "app"
  password = random_password.app.result
}

resource "google_sql_user" "migrator" {
  project  = var.project_id
  instance = google_sql_database_instance.postgres.name
  name     = "migrator"
  password = random_password.migrator.result
}

# ---------------------------------------------------------------------------
# Memorystore Redis — BASIC tier cache
# ---------------------------------------------------------------------------
# Loss-tolerant by design: the app degrades to Postgres reads and fail-open
# rate limiting when Redis is unavailable (PLAN §6), so BASIC (no replica) is
# the right-sized tier.

resource "google_redis_instance" "cache" {
  project        = var.project_id
  name           = local.name
  region         = var.region
  tier           = "BASIC"
  memory_size_gb = var.redis_memory_gb
  redis_version  = "REDIS_7_0"

  # Pinned explicitly: omitted, Memorystore silently lands on the project's
  # `default` network — unreachable from this VPC's direct egress (PLAN §8).
  authorized_network = var.network_id
  connect_mode       = "DIRECT_PEERING"

  auth_enabled = true

  # In-transit TLS deliberately off: traffic never leaves the private VPC,
  # and Memorystore TLS adds client/CA complexity for no exposure change
  # here. Accepted + documented in README's security section (PLAN §2).
  transit_encryption_mode = "DISABLED"
}

# ---------------------------------------------------------------------------
# Secret Manager — connection strings consumed by Cloud Run as env vars
# ---------------------------------------------------------------------------

locals {
  sql_host = google_sql_database_instance.postgres.private_ip_address

  app_database_url      = "postgresql://${google_sql_user.app.name}:${random_password.app.result}@${local.sql_host}:5432/${var.database_name}?schema=public"
  migrator_database_url = "postgresql://${google_sql_user.migrator.name}:${random_password.migrator.result}@${local.sql_host}:5432/${var.database_name}?schema=public"

  # The app consumes a single REDIS_URL (src/config.ts) and Cloud Run cannot
  # compose one env var from multiple secrets, so the AUTH string is stored
  # embedded in the connection URL rather than as a bare token.
  redis_url = "redis://:${google_redis_instance.cache.auth_string}@${google_redis_instance.cache.host}:${google_redis_instance.cache.port}"
}

resource "google_secret_manager_secret" "app_database_url" {
  project   = var.project_id
  secret_id = "${local.name}-database-url-app"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "app_database_url" {
  secret      = google_secret_manager_secret.app_database_url.id
  secret_data = local.app_database_url
}

resource "google_secret_manager_secret" "migrator_database_url" {
  project   = var.project_id
  secret_id = "${local.name}-database-url-migrator"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "migrator_database_url" {
  secret      = google_secret_manager_secret.migrator_database_url.id
  secret_data = local.migrator_database_url
}

resource "google_secret_manager_secret" "redis_url" {
  project   = var.project_id
  secret_id = "${local.name}-redis-url"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "redis_url" {
  secret      = google_secret_manager_secret.redis_url.id
  secret_data = local.redis_url
}
