#!/usr/bin/env bash
# Self-sufficient deploy smoke test (PLAN §9).
#
# Exercises auth + CRUD + audit + evaluate end-to-end against a deployed base
# URL, with zero credentials in the repo: the admin bootstrap token is fetched
# from Secret Manager via gcloud at runtime, a throwaway tenant + boolean flag
# are minted, evaluated, toggled, re-evaluated, and archived. Finally, recent
# Cloud Logging entries are grepped for the throwaway API key — if the key
# appears, header redaction is broken and the deploy fails.
#
# Usage:
#   scripts/smoke.sh <base-url>
#
# Environment:
#   ADMIN_TOKEN         optional override; when unset, fetched from Secret
#                       Manager (self-sufficient CI path)
#   ADMIN_TOKEN_SECRET  Secret Manager secret name  (default: flagship-admin-token)
#   GCP_PROJECT         optional --project for gcloud calls
#   SMOKE_ENVIRONMENT   flag environment to exercise (default: staging)
#   SMOKE_SERVICE       Cloud Run service name; enables the log-leak grep
#   SMOKE_LOG_WAIT_SECONDS  wait for Cloud Logging ingestion (default: 30)
set -euo pipefail

BASE_URL="${1:-}"
if [ -z "$BASE_URL" ]; then
  echo "usage: $0 <base-url>" >&2
  exit 2
fi
BASE_URL="${BASE_URL%/}"

ADMIN_TOKEN_SECRET="${ADMIN_TOKEN_SECRET:-flagship-admin-token}"
SMOKE_ENVIRONMENT="${SMOKE_ENVIRONMENT:-staging}"
SMOKE_SERVICE="${SMOKE_SERVICE:-}"
GCP_PROJECT="${GCP_PROJECT:-}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log()  { printf '>> %s\n' "$*"; }
fail() { printf 'SMOKE FAIL: %s\n' "$*" >&2; exit 1; }
# Keep secrets out of CI logs even if a later step prints them.
mask() { [ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$1" || true; }

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"

# gcloud project scoping via a helper (empty-array expansion under `set -u`
# breaks bash 3.2, which macOS still ships).
run_gcloud() {
  if [ -n "$GCP_PROJECT" ]; then
    gcloud --project "$GCP_PROJECT" "$@"
  else
    gcloud "$@"
  fi
}

# ---------------------------------------------------------------------------
# HTTP helper: sets STATUS and BODY globals.
#   http METHOD URL AUTH_HEADER [JSON_BODY]
# ---------------------------------------------------------------------------
STATUS=""
BODY=""
http() {
  local method="$1" url="$2" auth="$3" body="${4:-}"
  local args=(-sS --max-time 30 -X "$method"
    -H "$auth" -H 'Content-Type: application/json'
    -o "$TMP/body" -w '%{http_code}')
  [ -n "$body" ] && args+=(-d "$body")
  STATUS="$(curl "${args[@]}" "$url" || echo 000)"
  [ "$STATUS" = "000" ] && fail "curl $method $url did not complete"
  BODY="$(cat "$TMP/body" 2>/dev/null || true)"
}

expect_status() { # expected label
  [ "$STATUS" = "$1" ] || fail "$2: expected HTTP $1, got $STATUS — $BODY"
}

expect_2xx() { # label
  case "$STATUS" in 2??) ;; *) fail "$1: expected 2xx, got $STATUS — $BODY" ;; esac
}

# ---------------------------------------------------------------------------
# 1. Admin token: env override wins; otherwise Secret Manager (no creds in repo)
# ---------------------------------------------------------------------------
if [ -z "${ADMIN_TOKEN:-}" ]; then
  command -v gcloud >/dev/null 2>&1 \
    || fail "ADMIN_TOKEN is not set and gcloud is unavailable to fetch it"
  log "Fetching admin token from Secret Manager (secret: $ADMIN_TOKEN_SECRET)"
  ADMIN_TOKEN="$(run_gcloud secrets versions access latest \
    --secret "$ADMIN_TOKEN_SECRET")"
  [ -n "$ADMIN_TOKEN" ] || fail "empty admin token from Secret Manager"
fi
mask "$ADMIN_TOKEN"

# ---------------------------------------------------------------------------
# 2. Health — retry a few times in case the new revision is still settling
# ---------------------------------------------------------------------------
log "Probing $BASE_URL/healthz"
for attempt in $(seq 1 10); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$BASE_URL/healthz" || echo 000)"
  [ "$code" = "200" ] && break
  [ "$attempt" = "10" ] && fail "/healthz did not return 200 after 10 attempts (last: $code)"
  sleep 3
done
http GET "$BASE_URL/readyz" 'Accept: application/json'
expect_status 200 "/readyz"
log "Health OK: $BODY"

# ---------------------------------------------------------------------------
# 3. Mint a throwaway tenant (auth: X-Admin-Token)
# ---------------------------------------------------------------------------
TENANT_NAME="smoke-$(date +%s)-$RANDOM"
log "Creating throwaway tenant $TENANT_NAME"
http POST "$BASE_URL/api/v1/tenants" "X-Admin-Token: $ADMIN_TOKEN" \
  "{\"name\":\"$TENANT_NAME\"}"
expect_status 201 "create tenant"
TENANT_ID="$(jq -r '.tenant_id // empty' <<<"$BODY")"
API_KEY="$(jq -r '.api_key // empty' <<<"$BODY")"
[ -n "$TENANT_ID" ] && [ -n "$API_KEY" ] || fail "tenant response missing tenant_id/api_key"
mask "$API_KEY"
AUTH="X-API-Key: $API_KEY"
FLAGS_URL="$BASE_URL/api/v1/tenants/$TENANT_ID/flags"

# ---------------------------------------------------------------------------
# 4. Create a boolean flag (default OFF)
# ---------------------------------------------------------------------------
FLAG_KEY="smoke_flag"
log "Creating boolean flag $FLAG_KEY"
http POST "$FLAGS_URL" "$AUTH" \
  "{\"key\":\"$FLAG_KEY\",\"name\":\"Smoke flag\",\"description\":\"deploy smoke\",\"type\":\"boolean\",\"default_value\":false}"
expect_status 201 "create flag"

# ---------------------------------------------------------------------------
# 5. Evaluate while disabled: OFF value + FLAG_DISABLED
# ---------------------------------------------------------------------------
EVAL_BODY="{\"tenant_id\":\"$TENANT_ID\",\"environment\":\"$SMOKE_ENVIRONMENT\",\"user_id\":\"smoke-user\"}"
log "Evaluating (disabled) in $SMOKE_ENVIRONMENT"
http POST "$BASE_URL/api/v1/evaluate" "$AUTH" "$EVAL_BODY"
expect_2xx "evaluate (disabled)"
value="$(jq -r ".flags[\"$FLAG_KEY\"].value" <<<"$BODY")"
reason="$(jq -r ".flags[\"$FLAG_KEY\"].reason" <<<"$BODY")"
[ "$value" = "false" ] || fail "disabled evaluate: expected value false, got $value"
[ "$reason" = "FLAG_DISABLED" ] || fail "disabled evaluate: expected reason FLAG_DISABLED, got $reason"

# ---------------------------------------------------------------------------
# 6. Enable at 100% rollout
# ---------------------------------------------------------------------------
log "Enabling $FLAG_KEY at 100% in $SMOKE_ENVIRONMENT"
http PUT "$FLAGS_URL/$FLAG_KEY?environment=$SMOKE_ENVIRONMENT" "$AUTH" \
  '{"enabled":true,"rollout_percentage":100}'
expect_status 200 "enable flag"

# ---------------------------------------------------------------------------
# 7. Re-evaluate: ON value + FALLTHROUGH (enabled, no rules, 100% rollout)
# ---------------------------------------------------------------------------
log "Re-evaluating (enabled)"
http POST "$BASE_URL/api/v1/evaluate" "$AUTH" "$EVAL_BODY"
expect_2xx "evaluate (enabled)"
value="$(jq -r ".flags[\"$FLAG_KEY\"].value" <<<"$BODY")"
reason="$(jq -r ".flags[\"$FLAG_KEY\"].reason" <<<"$BODY")"
[ "$value" = "true" ] || fail "enabled evaluate: expected value true, got $value"
[ "$reason" = "FALLTHROUGH" ] || fail "enabled evaluate: expected reason FALLTHROUGH, got $reason"

# ---------------------------------------------------------------------------
# 8. Audit history records both changes
# ---------------------------------------------------------------------------
log "Checking audit history"
http GET "$FLAGS_URL/$FLAG_KEY/history" "$AUTH"
expect_status 200 "history"
actions="$(jq -r '[.history[].action] | join(",")' <<<"$BODY")"
case "$actions" in *flag.created*) ;; *) fail "history missing flag.created (got: $actions)" ;; esac
case "$actions" in *flag.updated*) ;; *) fail "history missing flag.updated (got: $actions)" ;; esac

# ---------------------------------------------------------------------------
# 9. Archive the throwaway flag (cleanup; also exercises soft delete)
# ---------------------------------------------------------------------------
log "Archiving $FLAG_KEY"
http DELETE "$FLAGS_URL/$FLAG_KEY" "$AUTH"
expect_status 200 "archive flag"
archived="$(jq -r '.status // empty' <<<"$BODY")"
[ "$archived" = "archived" ] || fail "archive: expected status archived, got $archived"

# ---------------------------------------------------------------------------
# 10. Secret-hygiene gate: the throwaway API key must NOT appear in Cloud
#     Logging. pino redaction is asserted by unit tests; this proves it live.
# ---------------------------------------------------------------------------
if [ -n "$SMOKE_SERVICE" ] && command -v gcloud >/dev/null 2>&1; then
  wait_s="${SMOKE_LOG_WAIT_SECONDS:-30}"
  log "Waiting ${wait_s}s for Cloud Logging ingestion, then grepping for the throwaway key"
  sleep "$wait_s"
  run_gcloud logging read \
    "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SMOKE_SERVICE\"" \
    --freshness=10m --limit=1000 --format=json >"$TMP/logs.json"
  entries="$(jq 'length' <"$TMP/logs.json")"
  if [ "$entries" -eq 0 ]; then
    log "WARN: no log entries returned yet (ingestion lag) — leak grep is vacuous this run"
  fi
  if grep -qF "$API_KEY" "$TMP/logs.json"; then
    fail "throwaway API key found in Cloud Logging — header redaction is broken"
  fi
  log "Log-leak grep clean across $entries recent entries"
else
  log "Skipping Cloud Logging leak grep (SMOKE_SERVICE unset or gcloud missing)"
fi

log "SMOKE PASS: $BASE_URL ($SMOKE_ENVIRONMENT) — tenant $TENANT_ID"
