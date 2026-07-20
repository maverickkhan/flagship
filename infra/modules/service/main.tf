# Service layer: the Cloud Run API service, the migration job, and the two
# runtime identities.
#
# TWO service accounts on purpose (PLAN §8/§11): the API runtime SA can read
# only the app (DML-only) DB secret; the migrator job SA can read only the
# migrator (schema-owner) DB secret. If the runtime identity could obtain
# schema-owner credentials, the app-user-DML-only / audit-immutability
# guarantees enforced in Postgres would be bypassable at the IAM layer.

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

# ---------------------------------------------------------------------------
# Identities
# ---------------------------------------------------------------------------

resource "google_service_account" "api" {
  project      = var.project_id
  account_id   = "${var.service}-api-${var.env}"
  display_name = "${local.name} API runtime"
  description  = "Cloud Run runtime identity: app DB secret, Redis URL, admin token, telemetry write."
}

resource "google_service_account" "migrator" {
  project      = var.project_id
  account_id   = "${var.service}-migrator-${var.env}"
  display_name = "${local.name} migrator job"
  description  = "Migration job identity: migrator DB secret only."
}

# ---------------------------------------------------------------------------
# Secret access — per-secret grants, never project-wide
# ---------------------------------------------------------------------------

resource "google_secret_manager_secret_iam_member" "api_db" {
  project   = var.project_id
  secret_id = var.app_db_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "api_redis" {
  project   = var.project_id
  secret_id = var.redis_url_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "api_admin_token" {
  project   = var.project_id
  secret_id = var.admin_token_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

# The migrator SA reads ONLY its own secret — and the API SA has no grant on
# it. Each identity sees exactly one DB credential.
resource "google_secret_manager_secret_iam_member" "migrator_db" {
  project   = var.project_id
  secret_id = var.migrator_db_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.migrator.email}"
}

# ---------------------------------------------------------------------------
# Telemetry roles for the API runtime
# ---------------------------------------------------------------------------

resource "google_project_iam_member" "api_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_trace_agent" {
  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.api.email}"
}

# ---------------------------------------------------------------------------
# CI deployer may deploy AS the runtime identities (actAs)
# ---------------------------------------------------------------------------
# Granted here, per-SA, rather than project-wide in bootstrap: these SAs do
# not exist yet when bootstrap runs, and per-SA grants are least privilege.

resource "google_service_account_iam_member" "deployer_actas_api" {
  count = var.deployer_service_account_email == "" ? 0 : 1

  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.deployer_service_account_email}"
}

resource "google_service_account_iam_member" "deployer_actas_migrator" {
  count = var.deployer_service_account_email == "" ? 0 : 1

  service_account_id = google_service_account.migrator.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.deployer_service_account_email}"
}

# ---------------------------------------------------------------------------
# Cloud Run service
# ---------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "api" {
  project  = var.project_id
  name     = local.name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  deletion_protection = var.deletion_protection

  template {
    service_account                  = google_service_account.api.email
    max_instance_request_concurrency = var.concurrency

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    # Direct VPC egress — no serverless connector to pay for or scale;
    # PRIVATE_RANGES_ONLY keeps public egress on Google's front end.
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"

      network_interfaces {
        network    = var.network_id
        subnetwork = var.subnet_id
      }
    }

    containers {
      image = var.image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }

        # Instance-based billing (CPU always allocated): the OTel exporter
        # flushes on a 60 s background timer that request-based CPU
        # throttling would starve between requests (PLAN §2/§10).
        cpu_idle          = false
        startup_cpu_boost = true
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "LOG_LEVEL"
        value = var.log_level
      }

      # Per-env tuning, e.g. rate-limit config (PLAN §6).
      dynamic "env" {
        for_each = var.env_vars

        content {
          name  = env.key
          value = env.value
        }
      }

      # Secrets are injected by reference (value_source) — values never
      # appear in this module, its plan output, or this stack's state.
      env {
        name = "DATABASE_URL"

        value_source {
          secret_key_ref {
            secret  = var.app_db_secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "REDIS_URL"

        value_source {
          secret_key_ref {
            secret  = var.redis_url_secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "ADMIN_TOKEN"

        value_source {
          secret_key_ref {
            secret  = var.admin_token_secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }

        initial_delay_seconds = 5
        period_seconds        = 5
        timeout_seconds       = 3
        failure_threshold     = 12
      }

      liveness_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }

        period_seconds    = 30
        timeout_seconds   = 3
        failure_threshold = 3
      }
    }
  }

  lifecycle {
    # CI owns the image (deploys push new revisions via gcloud); Terraform
    # owns the shape. Without this, every apply would revert the service to
    # the bootstrap image and roll back whatever CI last deployed.
    # client/client_version would otherwise flap between "terraform" and
    # "gcloud" on every deploy (PLAN §8, risk table §16).
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  # The first revision must be able to resolve its secrets at create time.
  depends_on = [
    google_secret_manager_secret_iam_member.api_db,
    google_secret_manager_secret_iam_member.api_redis,
    google_secret_manager_secret_iam_member.api_admin_token,
  ]
}

# Public invoker behind a variable: if an org policy forbids allUsers (proven
# in the phase-2 cloud smoke), flip allow_unauthenticated to false and use the
# ID-token curl fallback documented in docs/RUNBOOK.md (PLAN §16).
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  count = var.allow_unauthenticated ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---------------------------------------------------------------------------
# Migration job
# ---------------------------------------------------------------------------
# Runs the dedicated -migrate image (prisma CLI is a devDependency; the pruned
# runtime image cannot run migrations — PLAN §13) under the migrator SA.

resource "google_cloud_run_v2_job" "migrate" {
  project  = var.project_id
  name     = "${var.service}-migrate-${var.env}"
  location = var.region

  # The job itself is disposable glue; protection lives on the database.
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.migrator.email
      max_retries     = 1
      timeout         = "600s"

      # Jobs get NO VPC access by default — without this block (identical to
      # the service's) migrations cannot reach private-IP Cloud SQL (PLAN §8).
      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"

        network_interfaces {
          network    = var.network_id
          subnetwork = var.subnet_id
        }
      }

      containers {
        image = var.migrate_image

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {
          name = "DATABASE_URL"

          value_source {
            secret_key_ref {
              secret  = var.migrator_db_secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    # v2 jobs nest template-in-template — note the doubled path. Same
    # rationale as the service: CI points the job at each new -migrate tag
    # before executing it (PLAN §8/§9).
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [google_secret_manager_secret_iam_member.migrator_db]
}
