# RUNBOOK — Flagship (multi-tenant feature-flag service)

Operational procedures for the deployed service. Written for a first responder with
`gcloud` access and repo checkout; every action is a command, not a console click
(single documented exception: email notification-channel verification, see §7.3).

---

## 0. Conventions and prerequisites

```bash
export PROJECT_ID=<gcp-project-id>      # single project hosts BOTH envs (see DECISIONS.md #5)
export REGION=us-central1
gcloud config set project "$PROJECT_ID"
```

Resources are name-suffixed per environment (`staging` | `production`):

| Thing | Name pattern |
|---|---|
| Cloud Run service | `flagship-<env>` |
| Cloud Run migrate job | `flagship-migrate-<env>` |
| Cloud SQL instance | `flagship-<env>` |
| Memorystore Redis | `flagship-<env>` |
| Admin token secret | `flagship-admin-token` |
| Images (Artifact Registry) | `$REGION-docker.pkg.dev/$PROJECT_ID/flagship/api:sha-<git-sha>` (API) and `:sha-<git-sha>-migrate` (migrator) |

If a name drifts, `terraform -chdir=infra/envs/<env> output` is authoritative.

Terraform applies are **operator-run only** (`make tf-apply ENV=<env>`); CI validates
Terraform but never applies it and has no state-bucket access (DECISIONS.md #6).
CI owns the deployed **image**; Terraform owns the service **shape** (`ignore_changes`
on the image field) — never "fix" an image via `terraform apply`.

---

## 1. Deploy: staging

Runs automatically (`deploy-staging.yml`) on CI success on `main`. To replay by hand
(e.g. GitHub Actions outage), run exactly what the workflow runs:

```bash
SHA=<git-sha>   # must already be pushed to Artifact Registry by ci.yml
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/flagship/api"

# 1. Migrations first — always backward-compatible (expand/contract), so the
#    currently-serving revision keeps working while they run.
gcloud run jobs update flagship-migrate-staging \
  --image "$IMAGE:sha-$SHA-migrate" --region "$REGION"
gcloud run jobs execute flagship-migrate-staging --region "$REGION" --wait

# 2. Deploy at 100% (staging is not canaried).
gcloud run deploy flagship-staging \
  --image "$IMAGE:sha-$SHA" --region "$REGION"

# 3. Self-sufficient smoke — no credentials live in the repo; the workflow mints
#    everything it needs at run time.
ADMIN_TOKEN=$(gcloud secrets versions access latest --secret=flagship-admin-token)
BASE_URL=$(gcloud run services describe flagship-staging --region "$REGION" --format='value(status.url)')
```

Smoke sequence (what the workflow's script asserts):

```bash
# create throwaway tenant → returns {tenant_id, api_key}; key is shown once
RESP=$(curl -sf -X POST "$BASE_URL/api/v1/tenants" \
  -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"smoke-'"$(date +%s)"'"}')
TENANT=$(jq -r .tenant_id <<<"$RESP"); KEY=$(jq -r .api_key <<<"$RESP")

# boolean flag → enable at 100% in staging env → evaluate → assert value + reason
curl -sf -X POST "$BASE_URL/api/v1/tenants/$TENANT/flags" \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"key":"smoke-flag","name":"Smoke","type":"boolean","default_value":false}'
curl -sf -X PUT "$BASE_URL/api/v1/tenants/$TENANT/flags/smoke-flag?environment=staging" \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"enabled":true,"rollout_percentage":100}'
curl -sf -X POST "$BASE_URL/api/v1/evaluate" \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"tenant_id":"'"$TENANT"'","environment":"staging","user_id":"smoke-user","flag_keys":["smoke-flag"]}' \
  | jq -e '.flags["smoke-flag"].value == true and .flags["smoke-flag"].reason == "FALLTHROUGH"'

# archive (cleanup) + prove log redaction: the throwaway key must NOT appear in logs
curl -sf -X DELETE "$BASE_URL/api/v1/tenants/$TENANT/flags/smoke-flag" -H "X-API-Key: $KEY"
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="flagship-staging"' \
  --freshness=10m --format=json | grep -c "$KEY"   # expect 0
```

The log-grep step is why the deployer SA holds `roles/logging.viewer`.

---

## 2. Deploy: production (canary)

Manual dispatch of `deploy-production.yml` with an image tag input. Steps the
workflow runs, in order:

```bash
SHA=<git-sha>
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/flagship/api"

# 1. Migrations BEFORE any candidate traffic (expand/contract — old revision
#    must keep working during the traffic split).
gcloud run jobs update flagship-migrate-production \
  --image "$IMAGE:sha-$SHA-migrate" --region "$REGION"
gcloud run jobs execute flagship-migrate-production --region "$REGION" --wait

# 2. Deploy candidate at 0% traffic with a revision tag.
gcloud run deploy flagship-production \
  --image "$IMAGE:sha-$SHA" --region "$REGION" \
  --no-traffic --tag candidate

# 3. Resolve the candidate's tagged URL. Use trafficStatuses (the v2 status
#    field) — traffic[] has no URLs; NEVER hand-construct tagged URLs.
#    Poll until the field is populated (service reconciled).
CANDIDATE_URL=$(gcloud run services describe flagship-production \
  --region "$REGION" --format=json \
  | jq -r '.trafficStatuses[] | select(.tag=="candidate") | .uri')

# 4. Run the same self-sufficient smoke (§1) against $CANDIDATE_URL —
#    full auth + CRUD + audit + evaluate validation with ZERO user traffic.

# 5. Shift 10% and gate on synthetic traffic. A demo service has no organic
#    traffic, so the gate is deterministic requests, not a metric query that
#    could false-promote on empty data (DECISIONS.md #7).
gcloud run services update-traffic flagship-production \
  --region "$REGION" --to-tags candidate=10
MAIN_URL=$(gcloud run services describe flagship-production \
  --region "$REGION" --format='value(status.url)')
# workflow: ~200 curl requests through $MAIN_URL; failure ratio >1% → automated
# rollback (§3) and exit 1.

# 6. Healthy → promote.
gcloud run services update-traffic flagship-production \
  --region "$REGION" --to-tags candidate=100
```

---

## 3. Rollback — "fast, not warm"

Rollback is one command and takes effect in **seconds**:

```bash
# identify the previously serving revision
gcloud run revisions list --service flagship-production --region "$REGION" \
  --format='table(name, metadata.creationTimestamp, status.conditions[0].status)'

gcloud run services update-traffic flagship-production \
  --region "$REGION" --to-revisions <previous-revision>=100
```

**Caveat, stated precisely**: a revision at 0% traffic gets no service-level
minimum instances, so its instances scale to zero while it sits idle. The first
requests after rollback may therefore **cold-start (~2–4 s)**. Rollback is fast,
not warm.

**Warm variant (the production-grade version, documented not implemented here):**
keep a 1% split on the old revision during a soak window after promotion, so it
retains a warm instance and rollback is instant *and* warm:

```bash
gcloud run services update-traffic flagship-production \
  --region "$REGION" --to-tags candidate=99 --to-revisions <previous-revision>=1
# ...soak...; then candidate=100 once confident.
```

The canary workflow performs the §3 rollback automatically when the step-5 gate
fails; this section is for a human rolling back a bad promotion after the fact.

---

## 4. API key rotation (api_keys table)

Keys are per-tenant rows in `api_keys` (`key_hash` = SHA-256 of the key,
`key_prefix` for display, `revoked_at` for revocation). Multiple non-revoked keys
per tenant are valid simultaneously — rotation is **overlap, then revoke**, never
a hard cutover.

```bash
# 1. Generate the new key (32 random bytes, base64url, ff_ prefix — 46 chars total)
NEW_KEY="ff_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
HASH=$(printf '%s' "$NEW_KEY" | shasum -a 256 | cut -d' ' -f1)
PREFIX="${NEW_KEY:0:9}"
```

```sql
-- 2. Insert the new key (old key still valid → zero-downtime overlap)
INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, created_at)
VALUES (gen_random_uuid(), '<tenant_id>', '<HASH>', '<PREFIX>', now());

-- 3. Deliver NEW_KEY to the tenant out-of-band. Wait for cutover.

-- 4. Revoke the old key. Takes effect on the next request — the guard checks
--    revoked_at on every lookup; no restart needed (revoked key → 401).
UPDATE api_keys SET revoked_at = now()
WHERE tenant_id = '<tenant_id>' AND key_prefix = '<old_prefix>' AND revoked_at IS NULL;
```

**Access path**: Cloud SQL is private-IP only, so the SQL must run from inside the
VPC. Practical path in this stack — a one-off execution of the migrate job (it
already runs in-VPC as the migrator SA) with its args overridden to pipe the SQL
into `prisma db execute`:

```bash
gcloud run jobs execute flagship-migrate-<env> --region "$REGION" --wait \
  --update-env-vars="^@^ROTATE_SQL=$(cat rotate.sql)" \
  --args='sh,-c,printf "%s" "$ROTATE_SQL" | npx prisma db execute --stdin --url "$DATABASE_URL"'
```

(`^@^` is gcloud's alternate-delimiter syntax — the SQL contains commas. Any other
in-VPC SQL client also works; Cloud SQL Studio exists but is a console click.)

---

## 5. Admin token and demo credential rotation

> **Blast radius note:** `flagship-admin-token` is a single secret shared by BOTH environments (staging and production). Rotating it rotates operator access everywhere at once, and the evaluator token mailed for review can create tenants in production too — revoke both immediately after the review window.

The admin token guards `POST /api/v1/tenants` only. It lives solely in Secret
Manager; the running revision reads the version wired at deploy time.

```bash
# 1. Add a new version
openssl rand -base64 32 | gcloud secrets versions add flagship-admin-token --data-file=-

# 2. Roll the service so instances pick it up (any revision-creating update works)
gcloud run services update flagship-<env> --region "$REGION" \
  --update-env-vars="ADMIN_TOKEN_ROTATED_AT=$(date -u +%Y%m%dT%H%M%SZ)"

# 3. Destroy the old version once the new revision serves 100%
gcloud secrets versions list flagship-admin-token
gcloud secrets versions destroy <old-version-N> --secret=flagship-admin-token
```

**After the review window (mandatory):** the submission email contained (a) the
demo tenant API key and (b) a dedicated evaluator admin token (its own Secret
Manager version). Both must die once review is over:

1. Revoke the demo tenant's API key: §4 step 4 (`revoked_at = now()`).
2. Rotate the admin token per this section, destroying the version that was
   shared with the evaluator.
3. Confirm: demo key → `401`; old admin token → `401` on tenant creation.

---

## 6. Alert → first response

Three Terraform-managed alert policies. Ordered actions; stop when resolved.

| Alert | Meaning | First response |
|---|---|---|
| **5xx ratio > 5% over 5 min** (`run_googleapis_com/request_count`) | Serving errors — bad deploy, DB/Redis trouble, or a crashing revision | 1. Was there a deploy in the last hour? (`gcloud run revisions list --service flagship-production --region $REGION`) — if yes, **roll back first, diagnose second** (§3). 2. `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="flagship-production" AND severity>=ERROR' --freshness=15m` — group by `request_id`, read the error envelope `code`. 3. `curl $MAIN_URL/readyz` — failing PG or Redis ping narrows it to the data layer; check `gcloud sql instances describe flagship-production` / `gcloud redis instances describe flagship-production --region $REGION`. |
| **Evaluate latency p99 > 250 ms** | Evaluation slow — almost always the cache | 1. Dashboard: cache hit ratio. Hit ratio at ~0 means Redis is down/unreachable and every evaluate is falling through to Postgres (degraded mode, §8.1) — check the Redis instance. 2. Dashboard: SQL CPU — `db-f1-micro` saturates under cache-miss load; confirm the cache is the cause rather than upsizing first. 3. Instance count at max (3) with high per-instance load → raise `max_instances` in the env tfvars and `make tf-apply ENV=production`. 4. Sustained load from one tenant → confirm tenant rate limits are enforcing (429s in logs); noisy neighbor should be capped at 600 evals/min. |
| **Uptime check on `/healthz` failing** | Service not serving at all | 1. `gcloud run services describe flagship-production --region $REGION` — check the Ready condition and which revision has traffic. 2. Crash-looping new revision → startup-probe failures in logs → **roll back** (§3). 3. `gcloud logging read ... --freshness=10m` for startup errors (bad secret reference, migration/schema mismatch). 4. If the service is healthy but the check fails, verify the uptime check target survived the last `terraform apply`. |

Postmortem note ("never pages twice"): every page gets a written follow-up —
what fired, what the fix was, and which automation or alert-tuning change
prevents a repeat.

---

## 7. Known failure modes

### 7.1 Redis down → degraded mode, not down

By design the service **fails open** when Redis is unreachable:

- Flag-config cache falls through to Postgres — every evaluate hits the DB.
  Correctness is unaffected; latency rises (expect the p99 alert) and SQL CPU
  climbs.
- **Rate limiting fails open** — tenant and IP limits stop enforcing. Each
  failure is logged and counted in a metric; noisy-neighbor protection and
  key-guessing throttles are OFF while Redis is down. Treat a long Redis outage
  as a security posture change, not just a performance one.

Response: check `gcloud redis instances describe flagship-<env> --region $REGION`
(state, maintenance events). Memorystore BASIC has no replica — a failed instance
is re-created via Terraform (`make tf-apply ENV=<env>`); flag configs re-warm on
first read, nothing needs restoring.

### 7.2 Org policy blocks `allUsers` invoker

Some orgs enforce `constraints/iam.allowedPolicyMemberDomains`, which blocks the
public (`allUsers`) invoker binding. Proven early in this project (phase-2 cloud
smoke). If it bites in a new project:

```bash
# grant the caller instead of allUsers
gcloud run services add-iam-policy-binding flagship-<env> --region "$REGION" \
  --member="user:<evaluator-email>" --role="roles/run.invoker"

# callers then authenticate with an ID token
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "$BASE_URL/healthz"
```

The API's own `X-API-Key` auth is unchanged — the ID token only satisfies Cloud
Run's infrastructure-level invoker check, so callers send both headers.

### 7.3 Email notification channel UNVERIFIED

Terraform-created **email** notification channels start `UNVERIFIED` and
**silently drop notifications** — alerts fire but nobody is emailed. Verification
is a one-click link in the email, and it is the single documented exception to
no-console-clicks (DECISIONS.md #2). After any re-create of the channel:

```bash
gcloud beta monitoring channels list --format='table(displayName, type, verificationStatus)'
```

Anything not `VERIFIED` is a black hole — click the verification link, or switch
to a webhook channel (needs no verification).

---

## 8. Teardown / cost stop

Estimated burn fully running: **< $8/day** (smallest tiers, `min_instances=1` on
two services). Two levels:

### 8.1 Cost stop (keep data, near-zero spend)

```bash
# scale services to zero when idle
gcloud run services update flagship-<env> --region "$REGION" --min-instances=0

# stop Cloud SQL (data retained; restart with --activation-policy=ALWAYS)
gcloud sql instances patch flagship-<env> --activation-policy=NEVER

# Memorystore cannot be stopped — delete it; the app runs degraded (§7.1)
# without it, and terraform apply re-creates it (cache re-warms itself).
gcloud redis instances delete flagship-<env> --region "$REGION"
```

Residual cost: SQL storage, state-bucket storage, Artifact Registry storage.

### 8.2 Full teardown

Order matters — env stacks first, bootstrap last (it owns the state bucket).

```bash
# 1. Production: deletion protection is ON — flip it first
#    (set deletion_protection = false in infra/envs/production tfvars, then)
make tf-apply ENV=production
terraform -chdir=infra/envs/production destroy

# 2. Staging
terraform -chdir=infra/envs/staging destroy

# 3. Bootstrap (state bucket, Artifact Registry, WIF, deployer SA) — this
#    destroys Terraform state history; only after both envs are gone.
terraform -chdir=infra/bootstrap destroy

# 4. Sweep secrets created out-of-band by bootstrap/secrets.sh
gcloud secrets list && gcloud secrets delete <name>
```
