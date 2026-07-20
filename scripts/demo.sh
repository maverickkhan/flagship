#!/usr/bin/env bash
# Scripted curl tour of the flag lifecycle against a running stack (PLAN §13).
# Used by `make demo` against the local docker-compose stack.
#
#   create flag -> evaluate (off) -> toggle on -> evaluate (flip) -> history
#
# Usage:
#   scripts/demo.sh <base-url> <admin-token>
# e.g.
#   scripts/demo.sh http://localhost:8080 local-dev-admin-token
set -euo pipefail

BASE_URL="${1:-}"
ADMIN_TOKEN="${2:-}"
if [ -z "$BASE_URL" ] || [ -z "$ADMIN_TOKEN" ]; then
  echo "usage: $0 <base-url> <admin-token>" >&2
  exit 2
fi
BASE_URL="${BASE_URL%/}"
ENVIRONMENT="${DEMO_ENVIRONMENT:-development}"

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required (brew install jq / apt-get install jq)" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
show() { jq . <<<"$1"; }

request() { # METHOD URL AUTH_HEADER [JSON_BODY] -> sets STATUS/BODY
  local method="$1" url="$2" auth="$3" body="${4:-}"
  local args=(-sS --max-time 30 -X "$method"
    -H "$auth" -H 'Content-Type: application/json'
    -o "$TMP/body" -w '%{http_code}')
  [ -n "$body" ] && args+=(-d "$body")
  printf '   %s %s\n' "$method" "$url"
  STATUS="$(curl "${args[@]}" "$url")"
  BODY="$(cat "$TMP/body")"
  case "$STATUS" in
    2??) ;;
    *) echo "Request failed with HTTP $STATUS:" >&2; show "$BODY" >&2; exit 1 ;;
  esac
}

step "0. Health check"
request GET "$BASE_URL/readyz" 'Accept: application/json'
show "$BODY"

step "1. Create a demo tenant (X-Admin-Token) — API key is returned exactly once"
TENANT_NAME="demo-$(date +%s)"
request POST "$BASE_URL/api/v1/tenants" "X-Admin-Token: $ADMIN_TOKEN" \
  "{\"name\":\"$TENANT_NAME\"}"
show "$BODY"
TENANT_ID="$(jq -r .tenant_id <<<"$BODY")"
API_KEY="$(jq -r .api_key <<<"$BODY")"
AUTH="X-API-Key: $API_KEY"
FLAGS_URL="$BASE_URL/api/v1/tenants/$TENANT_ID/flags"

step "2. Create a boolean flag 'new_checkout' (default OFF)"
request POST "$FLAGS_URL" "$AUTH" \
  '{"key":"new_checkout","name":"New checkout flow","description":"Demo flag","type":"boolean","default_value":false}'
show "$BODY"

step "3. Evaluate for user \"42\" in $ENVIRONMENT — flag is disabled, serves the OFF value"
EVAL_BODY="{\"tenant_id\":\"$TENANT_ID\",\"environment\":\"$ENVIRONMENT\",\"user_id\":\"42\"}"
request POST "$BASE_URL/api/v1/evaluate" "$AUTH" "$EVAL_BODY"
show "$BODY"

step "4. Toggle it ON at 100% rollout in $ENVIRONMENT"
request PUT "$FLAGS_URL/new_checkout?environment=$ENVIRONMENT" "$AUTH" \
  '{"enabled":true,"rollout_percentage":100}'
show "$BODY"

step "5. Re-evaluate the same user — the value flips (cache invalidated on write)"
request POST "$BASE_URL/api/v1/evaluate" "$AUTH" "$EVAL_BODY"
show "$BODY"

step "6. Audit history — who, what, when, old/new values, newest first"
request GET "$FLAGS_URL/new_checkout/history" "$AUTH"
show "$BODY"

printf '\n\033[1mDemo complete.\033[0m Tenant %s (key %s...) — try the rollout yourself:\n' \
  "$TENANT_ID" "$(cut -c1-10 <<<"$API_KEY")"
cat <<EOF
  curl -s -X PUT '$FLAGS_URL/new_checkout?environment=$ENVIRONMENT' \\
    -H 'X-API-Key: $API_KEY' -H 'Content-Type: application/json' \\
    -d '{"rollout_percentage":40}'
  curl -s -X POST '$BASE_URL/api/v1/evaluate' \\
    -H 'X-API-Key: $API_KEY' -H 'Content-Type: application/json' \\
    -d '{"tenant_id":"$TENANT_ID","environment":"$ENVIRONMENT","user_id":"7"}'
EOF
