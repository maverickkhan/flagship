variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "region" {
  description = "Region for the subnet."
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

variable "subnet_cidr" {
  description = "CIDR for the Cloud Run direct-egress subnet (distinct per environment)."
  type        = string
}
