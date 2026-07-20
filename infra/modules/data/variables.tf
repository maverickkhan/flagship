variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "region" {
  description = "Region for Cloud SQL and Memorystore."
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

variable "network_id" {
  description = "VPC id from modules/network — its network_id output, which is chained through the PSA connection so Cloud SQL waits for Private Service Access."
  type        = string
}

variable "deletion_protection" {
  description = "Protect the Cloud SQL instance from destroy. True only in production."
  type        = bool
}

variable "sql_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-f1-micro"
}

variable "database_name" {
  description = "Application database name."
  type        = string
  default     = "flagship"
}

variable "redis_memory_gb" {
  description = "Memorystore capacity in GB."
  type        = number
  default     = 1
}
