#!/usr/bin/env bash
#
# Out-of-band secret provisioning — PLAN §8 "Secrets policy".
#
# The admin bootstrap token (and the evaluator's review-window token) are
# generated HERE, not in Terraform: the value goes straight from openssl into
# a Secret Manager version, so it never appears in Terraform state or in the
# repo. bootstrap/main.tf manages only the secret *container* and its IAM.
#
# Demo tenant credentials are deliberately NOT minted here: they are created
# at deploy time through the API (deploy smoke / operator curl) and delivered
# in the submission email — no working credential for any deployed URL ever
# appears in the repo.
#
# Usage:
#   ./secrets.sh <project-id>              mint/rotate the admin token
#   ./secrets.sh <project-id> --evaluator  add a separate evaluator token version
#
# The token is printed ONCE — deliver it via the submission email / operator
# password manager; it is not recoverable from this script afterwards.
# Rotation = run again (the new version becomes "latest") + redeploy.
# Revoking the evaluator token after the review window: docs/RUNBOOK.md.

set -euo pipefail

PROJECT_ID="${1:?usage: secrets.sh <project-id> [--evaluator]}"
KIND="${2:-}"

SECRET="flagship-admin-token"

# Idempotent: bootstrap Terraform normally creates the container first, but
# the script is safe standalone (first-run ordering does not matter).
if ! gcloud secrets describe "${SECRET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud secrets create "${SECRET}" \
    --project "${PROJECT_ID}" \
    --replication-policy automatic
fi

# base64url, no padding: safe in headers, shells and URLs.
TOKEN="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"

VERSION="$(printf '%s' "${TOKEN}" |
  gcloud secrets versions add "${SECRET}" \
    --project "${PROJECT_ID}" \
    --data-file=- \
    --format 'value(name)')"

if [[ "${KIND}" == "--evaluator" ]]; then
  echo "Evaluator admin token added as version ${VERSION##*/} (now \"latest\")."
  echo "Deliver it in the submission email; after the review window rotate it"
  echo "away with: ./secrets.sh ${PROJECT_ID}   (see docs/RUNBOOK.md)"
else
  echo "Admin token set (version ${VERSION##*/})."
fi

echo
echo "TOKEN (shown once): ${TOKEN}"
echo
echo "Cloud Run reads version \"latest\" — redeploy (or run the deploy"
echo "workflow) so running revisions pick up the new value."
