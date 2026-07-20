variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "env" {
  description = "Environment name (staging | production)."
  type        = string
}

variable "service" {
  description = "Service name prefix."
  type        = string
  default     = "flagship"
}

variable "notification_email" {
  description = "Recipient for alert notifications. NOTE: API-created email channels start UNVERIFIED — see the comment on the channel resource."
  type        = string
}

variable "service_name" {
  description = "Cloud Run service name to monitor (module.service.service_name)."
  type        = string
}

variable "service_hostname" {
  description = "Hostname of the deployed service for the uptime check (service URI without the https:// scheme)."
  type        = string
}

variable "database_id" {
  description = "Cloud SQL database id as \"<project>:<instance>\" for the SQL CPU chart."
  type        = string
}

variable "eval_latency_p99_threshold_ms" {
  description = "p99 evaluation-latency alert threshold, in milliseconds (the app records the histogram in ms)."
  type        = number
  default     = 250
}

variable "error_ratio_threshold" {
  description = "5xx ratio that trips the error alert (0.05 = 5%)."
  type        = number
  default     = 0.05
}

