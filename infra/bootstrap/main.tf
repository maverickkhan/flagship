# Run-once project bootstrap: APIs, the Terraform state bucket, Artifact
# Registry, Workload Identity Federation for GitHub Actions, and the CI
# deployer service account.
#
# Applied once by the human operator with LOCAL state — this stack creates the
# GCS state bucket, so it cannot store its own state there (chicken-and-egg;
# accepted for a run-once stack and noted in DECISIONS.md). Environment stacks
# (infra/envs/*) use the bucket created here.
#
# Companion: ./secrets.sh mints the admin bootstrap token (and the evaluator
# token) out-of-band so those values never touch Terraform state.

terraform {
  required_version = ">= 1.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  service      = "flagship"
  state_bucket = "${var.project_id}-tfstate"
}

# ---------------------------------------------------------------------------
# Project APIs
# ---------------------------------------------------------------------------

resource "google_project_service" "apis" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "redis.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
    "sts.googleapis.com",
    "vpcaccess.googleapis.com", # serverless-connector fallback path (PLAN §2)
  ])

  project = var.project_id
  service = each.value

  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# Terraform remote state
# ---------------------------------------------------------------------------

# Remote state for envs/{staging,production} — versioned because DB passwords
# and the Redis AUTH string unavoidably transit that state (see modules/data),
# and the GCS backend gives native state locking (no extra lock table).
#
# IAM — deliberately NO bindings here: access stays with the operator identity
# that runs bootstrap (project owner). The deployer SA is never granted state
# access at all: CI only ever runs `terraform init -backend=false` + validate,
# and applies are operator-run (`make tf-apply ENV=...`). Granting the GitHub
# identity read on a bucket whose objects contain secrets would be gratuitous
# privilege (PLAN §8).
resource "google_storage_bucket" "tfstate" {
  project  = var.project_id
  name     = local.state_bucket
  location = upper(var.region)

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  # Keep recovery points without unbounded growth.
  lifecycle_rule {
    action {
      type = "Delete"
    }

    condition {
      num_newer_versions = 20
      with_state         = "ARCHIVED"
    }
  }

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# Artifact Registry
# ---------------------------------------------------------------------------

resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = local.service
  format        = "DOCKER"
  description   = "Runtime (sha-<sha>) and migrator (sha-<sha>-migrate) images, pushed by CI via WIF."

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# Workload Identity Federation — GitHub Actions, no SA key JSON anywhere
# ---------------------------------------------------------------------------

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  description               = "Identity pool for GitHub Actions OIDC tokens."

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"

  # Pinned to exactly this repository AND the main branch: tokens minted for
  # any other repo or ref are rejected at the provider, before any IAM
  # evaluation. All deploying workflows (push to main, workflow_dispatch on
  # main) present ref refs/heads/main; PR runs never get deployer credentials.
  attribute_condition = "assertion.repository == \"${var.github_repository}\" && assertion.ref == \"refs/heads/main\""

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# ---------------------------------------------------------------------------
# Deployer service account (assumed by GitHub Actions via WIF)
# ---------------------------------------------------------------------------

resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = "${local.service}-deployer"
  display_name = "GitHub Actions deployer"
  description  = "CI identity: pushes images, deploys Cloud Run revisions, runs the migrate job, executes deploy smoke tests."
}

# Exact role list per PLAN §8/§11. Two role grants deliberately do NOT appear
# here:
#   - roles/iam.serviceAccountUser is granted per runtime SA inside
#     modules/service (bootstrap runs before those SAs exist, and per-SA
#     grants beat a project-wide one);
#   - state-bucket access is granted to nobody (see the tfstate bucket above).
resource "google_project_iam_member" "deployer" {
  for_each = toset([
    "roles/run.admin",               # deploy services + update/execute migrate jobs
    "roles/artifactregistry.writer", # push runtime + migrate images
    "roles/logging.viewer",          # smoke's log-grep step (`gcloud logging read` 403s without it)
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

# ---------------------------------------------------------------------------
# Admin bootstrap token — container only; value added by ./secrets.sh
# ---------------------------------------------------------------------------

# Secret CONTAINER only. The token value is added out-of-band by secrets.sh
# (`openssl rand ... | gcloud secrets versions add`), so it never appears in
# Terraform state: Terraform owns shape + IAM, gcloud owns the data (PLAN §8
# "Secrets policy"). Both env stacks reference this secret by name.
resource "google_secret_manager_secret" "admin_token" {
  project   = var.project_id
  secret_id = "${local.service}-admin-token"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

# Deploy smoke tests fetch the admin token at run time (self-sufficient smoke;
# no credentials in the repo) — a per-secret accessor grant, never
# project-wide.
resource "google_secret_manager_secret_iam_member" "deployer_admin_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.admin_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.deployer.email}"
}
