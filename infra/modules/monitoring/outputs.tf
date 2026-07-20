output "notification_channel_id" {
  description = "Email notification channel id (verify the address after first apply — see the resource comment)."
  value       = google_monitoring_notification_channel.email.id
}

output "uptime_check_id" {
  description = "Uptime check id for /healthz."
  value       = google_monitoring_uptime_check_config.healthz.uptime_check_id
}

output "dashboard_id" {
  description = "Service-overview dashboard resource id."
  value       = google_monitoring_dashboard.service.id
}
