variable "project_id" {
  description = "GCP project id hosting both environments (single project, name-suffixed resources — trade-off documented in README)."
  type        = string
}

variable "region" {
  description = "Primary region for all resources."
  type        = string
  default     = "us-central1"
}

variable "github_repository" {
  description = "GitHub repository as \"owner/repo\" allowed to authenticate via WIF. The pool provider's attribute_condition is pinned to exactly this value."
  type        = string
}
