# Monitoring: notification channel, alert policies, uptime check, and the
# service dashboard — all Terraform-managed (screenshots land in README; the
# alert -> first-response mapping lives in docs/RUNBOOK.md).
#
# Alert policies use PromQL (condition_prometheus_query_language): MQL has
# been deprecated since 2025, so PromQL is the current-practice query surface
# (PLAN §8).

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
# Notification channel
# ---------------------------------------------------------------------------

# CAVEAT — the single documented exception to "no console clicks": email
# channels created via the API start UNVERIFIED, and Cloud Monitoring silently
# drops their notifications until the recipient clicks the verification link.
# Automatable alternatives (importing a pre-verified channel, or a webhook /
# PagerDuty channel) are noted in DECISIONS.md; for this exercise the operator
# clicks the one verification email after the first apply (PLAN §8).
resource "google_monitoring_notification_channel" "email" {
  project      = var.project_id
  display_name = "${local.name} on-call email"
  type         = "email"

  labels = {
    email_address = var.notification_email
  }
}

# ---------------------------------------------------------------------------
# Alert: 5xx ratio > threshold over 5 minutes
# ---------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "error_ratio" {
  project      = var.project_id
  display_name = "${local.name}: 5xx ratio > ${var.error_ratio_threshold * 100}% (5m)"
  combiner     = "OR"

  conditions {
    display_name = "5xx / all requests over 5m"

    condition_prometheus_query_language {
      duration            = "300s"
      evaluation_interval = "60s"

      query = <<-EOT
        sum(rate(run_googleapis_com:request_count{monitored_resource="cloud_run_revision",service_name="${var.service_name}",response_code_class="5xx"}[5m]))
          /
        sum(rate(run_googleapis_com:request_count{monitored_resource="cloud_run_revision",service_name="${var.service_name}"}[5m]))
          > ${var.error_ratio_threshold}
      EOT
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  documentation {
    content   = "5xx ratio on ${local.name} exceeded ${var.error_ratio_threshold * 100}% for 5 minutes. First response: docs/RUNBOOK.md — check the latest deploy in Actions history; rollback is one `gcloud run services update-traffic` command."
    mime_type = "text/markdown"
  }
}

# ---------------------------------------------------------------------------
# Alert: evaluation latency p99 above threshold
# ---------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "eval_latency_p99" {
  project      = var.project_id
  display_name = "${local.name}: evaluation p99 > ${var.eval_latency_p99_threshold_ms}ms (5m)"
  combiner     = "OR"

  conditions {
    display_name = "p99 flag-evaluation latency"

    condition_prometheus_query_language {
      duration            = "300s"
      evaluation_interval = "60s"

      # `_bucket`: Cloud Monitoring exposes DISTRIBUTION-valued metrics to
      # PromQL as classic histogram series (_bucket/_sum/_count).
      query = <<-EOT
        histogram_quantile(
          0.99,
          sum by (le) (rate(${var.eval_latency_metric}_bucket{monitored_resource="generic_task"}[5m]))
        ) > ${var.eval_latency_p99_threshold_ms}
      EOT
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  documentation {
    content   = "p99 flag-evaluation latency on ${local.name} exceeded ${var.eval_latency_p99_threshold_ms}ms for 5 minutes. First response: docs/RUNBOOK.md — check cache hit ratio (Redis down degrades to Postgres reads) and Cloud SQL CPU on the dashboard."
    mime_type = "text/markdown"
  }
}

# ---------------------------------------------------------------------------
# Uptime check on /healthz + alert
# ---------------------------------------------------------------------------

resource "google_monitoring_uptime_check_config" "healthz" {
  project      = var.project_id
  display_name = "${local.name} /healthz"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path         = "/healthz"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"

    labels = {
      project_id = var.project_id
      host       = var.service_hostname
    }
  }
}

# check_passed is a BOOL metric spread across regional checkers; the canonical
# alert shape for it is a threshold condition over REDUCE_COUNT_FALSE (PromQL
# has no clean equivalent for bool uptime series), so this one policy
# deliberately stays on condition_threshold.
resource "google_monitoring_alert_policy" "uptime" {
  project      = var.project_id
  display_name = "${local.name}: /healthz uptime check failing"
  combiner     = "OR"

  conditions {
    display_name = "uptime check failures"

    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.healthz.uptime_check_id}\" AND resource.type=\"uptime_url\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.*"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  documentation {
    content   = "/healthz on ${local.name} is failing from external checkers. First response: docs/RUNBOOK.md — `gcloud run services describe ${var.service_name}`, then check revision health and roll back if a deploy is in flight."
    mime_type = "text/markdown"
  }
}

# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

resource "google_monitoring_dashboard" "service" {
  project = var.project_id

  dashboard_json = templatefile("${path.module}/dashboard.json.tftpl", {
    name                = local.name
    service_name        = var.service_name
    database_id         = var.database_id
    eval_latency_metric = var.eval_latency_metric
    evals_metric        = var.evals_metric
    http_metric         = var.http_metric
    cache_metric        = var.cache_metric
  })
}
