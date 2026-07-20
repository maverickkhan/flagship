variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "region" {
  description = "Cloud Run region."
  type        = string
  default     = "us-central1"
}

variable "env" {
  description = "Environment name (staging | production); suffixes every resource."
  type        = string
}

variable "service" {
  description = "Service name prefix for all resources."
  type        = string
  default     = "flagship"
}

variable "image" {
  description = "Initial API container image. Only used at create time — CI owns the image afterwards (lifecycle.ignore_changes)."
  type        = string
}

variable "migrate_image" {
  description = "Initial migration job image (the -migrate tag). Only used at create time — CI owns it afterwards."
  type        = string
}

variable "network_id" {
  description = "VPC id for direct VPC egress."
  type        = string
}

variable "subnet_id" {
  description = "Subnet id for direct VPC egress."
  type        = string
}

variable "app_db_secret_id" {
  description = "Secret Manager id of the app (DML-only) DATABASE_URL."
  type        = string
}

variable "migrator_db_secret_id" {
  description = "Secret Manager id of the migrator (schema-owner) DATABASE_URL."
  type        = string
}

variable "redis_url_secret_id" {
  description = "Secret Manager id of the REDIS_URL."
  type        = string
}

variable "admin_token_secret_id" {
  description = "Secret Manager id of the admin bootstrap token (created by infra/bootstrap, value via secrets.sh)."
  type        = string
}

variable "deployer_service_account_email" {
  description = "CI deployer SA email; granted roles/iam.serviceAccountUser on both runtime SAs. Empty string skips the grants."
  type        = string
  default     = ""
}

variable "allow_unauthenticated" {
  description = "Bind allUsers as run.invoker. Set false if an org policy forbids it (RUNBOOK documents the ID-token fallback)."
  type        = bool
  default     = true
}

variable "deletion_protection" {
  description = "Protect the Cloud Run service from destroy. True only in production."
  type        = bool
  default     = false
}

variable "min_instances" {
  description = "Minimum instance count (1 keeps the demo warm and the OTel exporter alive)."
  type        = number
  default     = 1
}

variable "max_instances" {
  description = "Maximum instance count."
  type        = number
  default     = 3
}

variable "concurrency" {
  description = "Max concurrent requests per instance."
  type        = number
  default     = 80
}

variable "cpu" {
  description = "CPU limit per instance."
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Memory limit per instance."
  type        = string
  default     = "512Mi"
}

variable "log_level" {
  description = "pino log level."
  type        = string
  default     = "info"
}

variable "env_vars" {
  description = "Additional plain env vars (per-env tuning such as RATE_LIMIT_* — PLAN §6). Never put secrets here; secrets go through Secret Manager references."
  type        = map(string)
  default     = {}
}
