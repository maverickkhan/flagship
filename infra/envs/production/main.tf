# Production — same shape as staging (one module composition, different
# tfvars/knobs): deletion protection ON, production rate limits, and
# min_instances=1 so rollbacks and canary shifts never hit a cold start on the
# serving revision (PLAN §8/§9).
#
# Assumes infra/bootstrap has been applied (APIs, state bucket, Artifact
# Registry, WIF, deployer SA, admin-token secret + secrets.sh).

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

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  env     = "production"
  service = "flagship"

  registry      = "${var.region}-docker.pkg.dev/${var.project_id}/${local.service}"
  image         = coalesce(var.image, "${local.registry}/api:bootstrap")
  migrate_image = coalesce(var.migrate_image, "${local.registry}/api:bootstrap-migrate")

  # Created by infra/bootstrap.
  deployer_service_account_email = "${local.service}-deployer@${var.project_id}.iam.gserviceaccount.com"
  admin_token_secret_id          = "${local.service}-admin-token"
}

module "network" {
  source = "../../modules/network"

  project_id  = var.project_id
  region      = var.region
  env         = local.env
  service     = local.service
  subnet_cidr = "10.20.0.0/24"
}

module "data" {
  source = "../../modules/data"

  project_id          = var.project_id
  region              = var.region
  env                 = local.env
  service             = local.service
  network_id          = module.network.network_id
  deletion_protection = true

  # Belt-and-braces with the network module's output chaining: Cloud SQL's
  # first apply must not race the Private Service Access connection (PLAN §8).
  depends_on = [module.network]
}

module "service" {
  source = "../../modules/service"

  project_id = var.project_id
  region     = var.region
  env        = local.env
  service    = local.service

  image         = local.image
  migrate_image = local.migrate_image

  network_id = module.network.network_id
  subnet_id  = module.network.subnet_id

  app_db_secret_id      = module.data.app_db_secret_id
  migrator_db_secret_id = module.data.migrator_db_secret_id
  redis_url_secret_id   = module.data.redis_url_secret_id
  admin_token_secret_id = local.admin_token_secret_id

  deployer_service_account_email = local.deployer_service_account_email

  allow_unauthenticated = true
  deletion_protection   = true
  min_instances         = 1
  max_instances         = 3
  concurrency           = 80

  env_vars = {
    # Production keeps the real limits (PLAN §6): evaluate 600/min,
    # management 120/min, unauthenticated-IP 60/min.
    RATE_LIMIT_EVALUATE_PER_MIN   = "600"
    RATE_LIMIT_MANAGEMENT_PER_MIN = "120"
    RATE_LIMIT_IP_PER_MIN         = "60"
  }
}

module "monitoring" {
  source = "../../modules/monitoring"

  project_id         = var.project_id
  env                = local.env
  service            = local.service
  notification_email = var.alert_email
  service_name       = module.service.service_name
  service_hostname   = trimprefix(module.service.service_uri, "https://")
  database_id        = "${var.project_id}:${module.data.sql_instance_name}"
}
