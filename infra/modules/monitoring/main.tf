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
# Log-based metrics (PLAN §10 fallback, promoted to the shipped design):
# the app emits structured pino events; these metrics derive the custom
# observability signals from them with zero in-process exporter risk.
# Names are PromQL-safe (underscores) and env-suffixed — metrics are
# project-global while this module is instantiated per environment.
# ---------------------------------------------------------------------------

locals {
  metric_prefix = replace(local.name, "-", "_")
  log_base      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.service_name}\""

  eval_latency_promql = "logging_googleapis_com:user_${google_logging_metric.eval_latency.name}"
  evals_promql        = "logging_googleapis_com:user_${google_logging_metric.evals_count.name}"
  http_promql         = "logging_googleapis_com:user_${google_logging_metric.http_requests.name}"
  cache_promql        = "logging_googleapis_com:user_${google_logging_metric.cache_events.name}"
}

resource "google_logging_metric" "eval_latency" {
  project         = var.project_id
  name            = "${local.metric_prefix}_eval_latency"
  filter          = "${local.log_base} AND jsonPayload.event=\"flag_evaluation\""
  value_extractor = "EXTRACT(jsonPayload.duration_ms)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"

    labels {
      key        = "tenant"
      value_type = "STRING"
    }
  }

  label_extractors = {
    tenant = "EXTRACT(jsonPayload.tenant_id)"
  }

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 32
      growth_factor      = 1.5
      scale              = 0.5
    }
  }
}

resource "google_logging_metric" "evals_count" {
  project = var.project_id
  name    = "${local.metric_prefix}_evals_count"
  filter  = "${local.log_base} AND jsonPayload.event=\"flag_evaluation\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"

    labels {
      key        = "tenant"
      value_type = "STRING"
    }
  }

  label_extractors = {
    tenant = "EXTRACT(jsonPayload.tenant_id)"
  }
}

resource "google_logging_metric" "http_requests" {
  project = var.project_id
  name    = "${local.metric_prefix}_http_requests"
  filter  = "${local.log_base} AND jsonPayload.message=\"request completed\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"

    labels {
      key        = "endpoint"
      value_type = "STRING"
    }

    labels {
      # First digit of the status code ("2", "4", "5") — log-based label
      # extractors cannot compute "5xx", so dashboards filter on "5".
      key        = "status_class"
      value_type = "STRING"
    }

    labels {
      # Spec asks for error rate per tenant + endpoint; request logs carry
      # tenant_id for authenticated calls (empty for anonymous ones).
      key        = "tenant"
      value_type = "STRING"
    }
  }

  label_extractors = {
    endpoint     = "REGEXP_EXTRACT(jsonPayload.req.url, \"^/(?:api/v1/)?([a-z]+)\")"
    status_class = "REGEXP_EXTRACT(jsonPayload.res.statusCode, \"^([0-9])\")"
    tenant       = "EXTRACT(jsonPayload.tenant_id)"
  }
}

resource "google_logging_metric" "cache_events" {
  project = var.project_id
  name    = "${local.metric_prefix}_cache_events"
  filter  = "${local.log_base} AND jsonPayload.event=\"flag_cache\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"

    labels {
      key        = "event"
      value_type = "STRING"
    }
  }

  label_extractors = {
    event = "EXTRACT(jsonPayload.outcome)"
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
          sum by (le) (rate(${local.eval_latency_promql}_bucket{monitored_resource="cloud_run_revision"}[5m]))
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
# Uptime check + alert. Path is /readyz, NOT /healthz: Google's frontend
# intercepts the exact path /healthz on *.run.app domains and serves its own
# 404 before the request reaches the container (container-internal probes are
# unaffected). Discovered empirically; documented in DECISIONS.md.
# ---------------------------------------------------------------------------

resource "google_monitoring_uptime_check_config" "healthz" {
  project      = var.project_id
  display_name = "${local.name} /readyz"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path         = "/readyz"
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
  display_name = "${local.name}: /readyz uptime check failing"
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
    content   = "/readyz on ${local.name} is failing from external checkers. First response: docs/RUNBOOK.md — `gcloud run services describe ${var.service_name}`, then check revision health and roll back if a deploy is in flight."
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
    eval_latency_metric = local.eval_latency_promql
    evals_metric        = local.evals_promql
    http_metric         = local.http_promql
    cache_metric        = local.cache_promql
  })
}
