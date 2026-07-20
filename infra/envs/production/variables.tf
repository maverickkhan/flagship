variable "project_id" {
  description = "GCP project id (must match the state bucket name hardcoded in backend.tf)."
  type        = string
}

variable "region" {
  description = "Region for all resources."
  type        = string
  default     = "us-central1"
}

variable "alert_email" {
  description = "Recipient for monitoring alerts (email channels need one-time verification — see modules/monitoring)."
  type        = string
}

variable "image" {
  description = "Override the initial API image (defaults to the :bootstrap tag in this project's Artifact Registry). CI owns the image after creation."
  type        = string
  default     = null
}

variable "migrate_image" {
  description = "Override the initial migration image (defaults to the :bootstrap-migrate tag). CI owns it after creation."
  type        = string
  default     = null
}
