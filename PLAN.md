# Execution Plan v2 — Multi-Tenant Config & Feature Flag Service

Take-home for Contrarian Thinking — Backend & Platform. Target: working deployed system on GCP + repo scoring across all six rubric areas. Single source of truth for implementation; every phase has "done when" gates. v2 incorporates a 4-lens adversarial review (rubric / GCP facts / pragmatism / security).

---

## 0. Objectives and non-goals

**Objectives**
1. Working multi-tenant feature-flag API deployed on Cloud Run, public URL, demo credentials the evaluator can actually use.
2. Deterministic percentage rollout engine with tests proving determinism, stickiness, distribution, independence.
3. Full Terraform coverage (no console clicks), env separation (staging/production), GCS remote state with locking.
4. GitHub Actions: lint → typecheck → tests (coverage gate) → vulnerability scans → build → push → canary deploy with traffic splitting + automated rollback.
5. Observability: JSON logs + correlation IDs, custom metrics, dashboard, alert policies — all Terraform-managed.
6. Documentation that wins the 20% docs/decisions score + RUNBOOK mirroring the job post's on-call culture.

**Non-goals (stated in README)**: no admin UI; no user SSO (Auth0 noted as future work); single region us-central1; no HA; SSE is bonus, built last.

**De-risking principle (v2)**: every cloud unknown (billing, org policy, WIF, image push, Cloud Run deploy) is proven in hour ~2, not hour ~10. Stateful resources (Cloud SQL, Redis) start provisioning early so wall-clock waits overlap coding.

---

## 1. Architecture summary

```
clients --HTTPS/X-API-Key--> Cloud Run (NestJS, revision N / N+1 traffic split)
    --direct VPC egress--> Cloud SQL Postgres 16 (private IP)   [source of truth]
    --direct VPC egress--> Memorystore Redis (AUTH enabled)     [flag-config cache, rate limits, pub/sub]
    secrets: Secret Manager -> env vars   images: Artifact Registry
    deploys: GitHub Actions via Workload Identity Federation
    telemetry: pino JSON -> Cloud Logging ; OTel metrics -> Cloud Monitoring ; dashboard+alerts via Terraform
```

Two environments = two Terraform roots (`infra/envs/{staging,production}`), one GCP project, name-suffixed resources, separate state prefixes. Trade-off documented: ideal is project-per-env; single project conserves the $300 credit and quota-approval time.

### Request pipeline (NestJS)

```
request
 → correlation-id middleware (accept X-Request-ID or generate; echo back; bind to logger)
 → pino-http JSON logging (severity, trace field for Cloud Run log correlation; **redact: x-api-key, x-admin-token, authorization, cookie, set-cookie** — pino-http logs req.headers by default, unredacted keys would persist in Cloud Logging)
 → IpRateLimitGuard (unauthenticated paths + all 401 outcomes: IP-keyed Redis fixed window — blocks key-guessing floods from reaching Postgres; client IP via Express `trust proxy` set to the trusted hop count — 1 for bare Cloud Run — so `req.ip` resolves the nearest untrusted XFF entry; naive leftmost is spoofable, naive rightmost can be a proxy IP)
 → ApiKeyGuard (SHA-256 lookup in api_keys → attaches tenant) | AdminTokenGuard (timingSafeEqual on SHA-256 digests)
 → TenantScopeGuard (URL/body tenant must match key's tenant → else 403)
 → TenantRateLimitGuard (Redis fixed window per tenant per route class → 429 + Retry-After)
 → controller → service (Prisma tx) → response envelope
 → exception filter ({error:{code,message}, request_id})
 → metrics interceptor (OTel histogram/counters, per-tenant attrs)
```

---

## 2. Stack (locked)

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript, Node 22 LTS | test preference |
| Framework | NestJS 11 | test-recommended; guards/interceptors map to multi-tenancy |
| ORM | Prisma **6.x pinned** (deliberately not 7: v7 requires driver-adapter + ESM rewiring that buys nothing here; DECISIONS.md logs the upgrade as future work) | migrations are a required deliverable; v6 has mature CommonJS/NestJS integration |
| DB | Cloud SQL PG16 `db-f1-micro`, private IP, two DB users (migrator owns schema; app user has DML only, INSERT/SELECT only on audit_logs) | required; least-privilege at DB layer backs the audit-immutability claim |
| Cache | Memorystore Redis BASIC 1 GB, `auth_enabled=true`, no TLS (accepted: private VPC; documented) | required |
| Compute | Cloud Run v2, **`cpu_idle=false` (instance-based billing)**, `min_instances=1` on demo env | traffic-split canary; CPU always-on so OTel background export works |
| VPC access | Direct VPC egress (`PRIVATE_RANGES_ONLY`); serverless-connector variant kept as module flag fallback | no connector cost; documented |
| IaC | Terraform, GCS remote state (native locking), modules | test + job-post verbatim |
| CI/CD | GitHub Actions + WIF (`google-github-actions/auth`) | job-post stack; no SA keys |
| Logs | pino via nestjs-pino | Cloud Logging auto-parses |
| Metrics | OTel SDK → Cloud Monitoring exporter, **with GCP resource detector + unique `service.instance.id`** (avoids multi-instance time-series collisions); **pre-drafted fallback: Terraform log-based metrics** if exporter fights back (45-min timebox) | job post names OTel; fallback kills the known #1 time sink |
| Load test | k6, run from GitHub Actions US runner against staging | proximity to us-central1; reproducible |
| Container | multi-stage → `node:22-slim` + `openssl ca-certificates` (Prisma engine needs libssl), non-root, node-based HEALTHCHECK | slim not alpine (glibc); wget/curl absent in slim — healthcheck uses `node -e "fetch(...)"` |

---

## 3. Data model

Shared-schema multi-tenancy; every table carries `tenant_id`; all queries tenant-scoped from the API key.

```sql
flag_type:    'boolean' | 'string' | 'number'
flag_status:  'active' | 'archived'
environment:  'development' | 'staging' | 'production'
audit_action: 'flag.created' | 'flag.updated' | 'flag.archived' | 'flag.unarchived'

tenants
  id uuid PK, name text UNIQUE NOT NULL, created_at timestamptz

api_keys                              -- separate table: enables rotation + revocation
  id uuid PK
  tenant_id uuid FK -> tenants ON DELETE CASCADE
  key_hash text UNIQUE NOT NULL       -- sha256(key); indexed lookup
  key_prefix text NOT NULL            -- "ff_a1b2c3" display-only
  revoked_at timestamptz NULL
  created_at timestamptz
  INDEX (tenant_id)

flags
  id uuid PK, tenant_id FK, key text (slug), name, description,
  type flag_type, default_value jsonb NOT NULL,     -- the OFF/fallback value
  status flag_status default 'active', created_at, updated_at
  UNIQUE (tenant_id, key); UNIQUE (id, tenant_id)   -- referenced by flag_environments' composite FK
  INDEX (tenant_id, status)

flag_environments                     -- per-env state; 3 rows auto-created per flag
  id uuid PK, flag_id FK CASCADE, tenant_id uuid NOT NULL,   -- denormalized on purpose: every table carries tenant_id; composite FK (flag_id, tenant_id) -> flags(id, tenant_id) keeps it consistent
  environment,
  enabled bool default false,
  serve_value jsonb NOT NULL,         -- the ON value (boolean→true; string/number→operator-set; defaults to default_value at creation)
  rollout_percentage numeric(5,2) default 100 CHECK 0..100,
  targeting_rules jsonb default '[]',
  variants jsonb NULL,                -- optional weighted variants (string flags)
  updated_at
  UNIQUE (flag_id, environment); INDEX (tenant_id, environment)

audit_logs                            -- append-only
  id bigint IDENTITY PK, tenant_id, flag_id, actor text, action audit_action,
  environment NULL, old_value jsonb, new_value jsonb, request_id text, created_at
  INDEX (flag_id, created_at DESC)
```

**Serve semantics (explicit, per type — closes the "rollout is a no-op for string/number" hole):** every flag has an OFF value (`flags.default_value`) and per-env ON value (`flag_environments.serve_value`). Disabled or rollout-miss → OFF value (yes, a boolean whose operator set default_value=true serves true when disabled — the OFF state is operator-defined, documented). Enabled + targeting match → rule's serve. Enabled + in-rollout → serve_value (or weighted variant pick). This makes percentage rollout meaningful for all three types (number: 500 for 20% of users, 250 for the rest).

**Audit immutability, honestly claimed**: trigger `BEFORE UPDATE OR DELETE ON audit_logs → RAISE EXCEPTION`, plus the app DB user is granted only INSERT/SELECT on audit_logs (migrations run as the separate migrator/owner user, grants applied in migration SQL). README scopes the claim: guards against application bugs and the runtime credential; a compromised DB owner is out of scope.

**Unarchive path exists** (evaluator probe): `PUT` with `{status:"active"}` → `flag.unarchived` audit row.

## 4. API contract

Auth: `X-API-Key: ff_<43 chars base64url>` (32 random bytes) everywhere except: `POST /api/v1/tenants` (`X-Admin-Token` — platform-operator bootstrap secret; compared via `timingSafeEqual` over SHA-256 digests; documented assumption) and `/healthz|/readyz`.

| Endpoint | Notes |
|---|---|
| `POST /api/v1/tenants` | `{name}` → `201 {tenant_id, api_key}` — key shown once; hash stored |
| `POST /api/v1/tenants/{id}/flags` | `{key,name,description?,type,default_value}` → flag + 3 env rows (disabled, serve_value=default) + audit |
| `GET /api/v1/tenants/{id}/flags?environment=&status=&page=&per_page=` | env state inlined; paginated |
| `PUT /api/v1/tenants/{id}/flags/{flag_key}[?environment=]` | env-scoped fields (`enabled, serve_value, rollout_percentage, targeting_rules, variants`) need `environment`; flag-level (`name, description, default_value, status`) without; `status:"active"` restores archived flag; every change = one tx + audit row (old/new JSONB) + cache invalidation |
| `DELETE /api/v1/tenants/{id}/flags/{flag_key}` | archive (soft) + audit |
| `GET /api/v1/tenants/{id}/flags/{flag_key}/history?page=` | audit rows, newest first |
| `POST /api/v1/evaluate` | `{tenant_id, environment, user_id, context?, flag_keys?}` |
| `POST /api/v1/evaluate/bulk` | all active flags for context |
| `GET /api/v1/stream?environment=` | **bonus** SSE; heartbeat every 25 s |
| `GET /healthz` / `GET /readyz` | liveness / readiness (PG+Redis ping) |

Evaluate response: `{environment, flags: {<key>: {value, reason}}, request_id}`. Reasons: `FLAG_ARCHIVED | FLAG_DISABLED | TARGETING_MATCH | ROLLOUT_MATCH | ROLLOUT_MISS | FALLTHROUGH`. Error envelope: `{"error":{"code","message"},"request_id"}` with proper 400/401/403/404/409/422/429.

`tenant_id` in URL/body AND derived from key; key is authoritative; mismatch → 403 (deliberate isolation test surface).

## 5. Evaluation engine

Pure module (`src/evaluation/engine/`), no I/O.

```
bucket(tenantId, flagKey, userId):
  sha256(`${tenantId}:${flagKey}:${userId}`) → first 8 hex chars → int / 0x100000000 * 100   // [0,100)

evaluate(flag, envState, userId, context):
  archived        → {default_value, FLAG_ARCHIVED}     // excluded from bulk
  !enabled        → {default_value, FLAG_DISABLED}
  rule match      → {rule.serve, TARGETING_MATCH}      // first-match-wins over context attrs
  pct < 100 and bucket >= pct → {default_value, ROLLOUT_MISS}
  variants set    → weighted pick by re-scaled bucket  → {variant, ROLLOUT_MATCH}
  else            → {serve_value, reason: pct < 100 ? ROLLOUT_MATCH : FALLTHROUGH}
```

Properties proven by unit tests: (1) determinism — 1 000 repeat calls identical; (2) stickiness — enabled-set at 20 % ⊆ set at 50 %; (3) uniformity — 100 k users, each decile 10 % ± 1 pp; (4) flag independence — two flags' 10 % cohorts overlap ≈ 1 %; (5) tenant cohort isolation. Plus a serve-semantics matrix test: {boolean,string,number} × {disabled, targeting, in-rollout, out-of-rollout, archived}.

Why SHA-256 over murmur3 (README): zero deps, identical result in any client language, well-studied avalanche; ~1 µs is noise vs I/O. Environment deliberately NOT hashed: same cohort across envs → rollouts testable in staging before prod (documented).

## 6. Caching & rate limiting

- **Cache flag configs, not per-user results.** `flagcfg:{tenantId}:{env}` → JSON of active flags+env state; TTL 300 s backstop; explicit DEL (3 env keys) after every mutation tx commit. Rejected per-user result cache documented (cardinality, stale toggles).
- **Redis down = degraded not down**: cache falls through to Postgres; rate limiting fails open (logged + metric).
- **Tenant limits**: `INCR`+`EXPIRE 60` on `rl:t:{tenantId}:{class}:{minute}`; classes evaluate 600/min, management 120/min; **limits are per-env config** (`RATE_LIMIT_EVALUATE_PER_MIN` etc.): staging runs a high evaluate limit so k6 measures the engine, not the limiter (documented in DECISIONS.md); production keeps 600/min; enforcement itself is proven by integration tests + prod config. `RATE_LIMIT_EXEMPT_TENANTS` also supported. 429 + Retry-After.
- **IP limits (unauthenticated surface)**: `rl:ip:{ip}:{minute}` on tenant creation + any request failing auth, 60/min — keeps key-guessing floods off Postgres. Client IP resolved by Express `trust proxy` = trusted hop count (1 for bare Cloud Run; revisit if an LB is added) → `req.ip` = nearest untrusted XFF entry. Documented: leftmost is client-spoofable, blind rightmost can rate-limit a proxy; hop-count parsing is the correct middle.

## 7. Repo layout

```
├── src/ (main.ts, otel.ts, app.module.ts, common/, auth/, tenants/, flags/, audit/, evaluation/, realtime/, health/, redis/)
├── prisma/schema.prisma + migrations/ + seed.ts        # seed = LOCAL COMPOSE ONLY (no cloud creds in repo)
├── test/ (integration: isolation, env scoping, auth, audit, cache invalidation)
├── load-test/evaluate.k6.js
├── infra/
│   ├── bootstrap/           # run-once: state bucket (+IAM hardening), APIs, Artifact Registry, WIF pool+provider, deployer SA, out-of-band secrets script
│   ├── modules/{network,data,service,monitoring}       # data = Cloud SQL + Redis + secret wiring
│   └── envs/{staging,production}/
├── .github/workflows/{ci.yml,deploy-staging.yml,deploy-production.yml,load-test.yml}
├── docs/{REQUIREMENTS.md,RUNBOOK.md}
├── Dockerfile  docker-compose.yml  .env.example  Makefile
└── README.md  DECISIONS.md
```

Design-decision writeups live as a numbered section in README (8 entries: Cloud Run over GKE/GCE; shared-schema tenancy; SHA-256 bucketing; config-not-result caching; direct VPC egress; fixed-window limits; secrets/state trade-off; OTel + fallback) — same content as ADRs without file ceremony.

## 8. Terraform design

State: GCS bucket, versioned, **IAM restricted to the operator identity only** — the deployer SA gets no state access at all: CI validates but never applies, and state contains secrets (see below), so granting the GitHub identity state read would be gratuitous privilege. `bootstrap/` applied once by operator; env applies operator-run (`make tf-apply ENV=staging`); documented choice.

**Secrets policy (explicit, graded)**: admin bootstrap token + demo credentials are created **out-of-band** by `bootstrap/secrets.sh` (`openssl rand -base64 32 | gcloud secrets versions add ...`) — Terraform references these secrets by name only, values never in state. DB password + Redis AUTH string unavoidably transit Terraform state (`google_sql_user`, `redis_instance.auth_string`) — mitigated by state-bucket IAM + versioning, and README says so out loud with the production-grade alternative (IAM DB auth / out-of-band user creation). Silence loses points; the honest paragraph wins them.

Modules:
- **network**: VPC, subnet, PSA range + `service_networking_connection`; no ingress firewall (nothing in-VPC listens publicly).
- **data**: Cloud SQL PG16 `db-f1-micro` private IP, **`settings.edition = "ENTERPRISE"` set explicitly** (PG16+ defaults to Enterprise Plus, where shared-core tiers are invalid — unset, the apply fails), **`depends_on` the network module's `google_service_networking_connection`** (Terraform doesn't infer the PSA dependency from the private network reference; without it the first apply races), backups on, `deletion_protection` var; two SQL users (`app`, `migrator`) + DBs; Memorystore BASIC 1 GB `auth_enabled=true`, **`authorized_network` pinned to the module VPC** (omitted = silently lands on the `default` network, unreachable from direct VPC egress) with `connect_mode = DIRECT_PEERING`; Secret Manager secrets for both connection strings + redis auth.
- **service**: **two service accounts** — API runtime SA (app-DB secret + redis-auth `secretAccessor` per-secret, `monitoring.metricWriter`, `cloudtrace.agent`; **cannot read the migrator DB secret**, or the app-user-DML-only/audit-immutability claim would be bypassed) and migrator job SA (migrator-DB secret only); `google_cloud_run_v2_service` — direct VPC egress, `cpu_idle=false`, startup+liveness probes on `/healthz`, min 1 / max 3, concurrency 80, secrets via `value_source`, **`lifecycle { ignore_changes = [template[0].containers[0].image, client, client_version] }`** (CI owns the image, Terraform owns the shape — prevents apply from reverting deployed revisions; called out in README); migrate `google_cloud_run_v2_job` running the dedicated `migrate` image under the migrator SA **with the same direct-VPC-egress block as the service** (jobs get no VPC access by default — without it migrations cannot reach private-IP Cloud SQL), with the job-shaped ignore path **`template[0].template[0].containers[0].image`** (v2 jobs nest template-in-template); `allUsers` invoker (org-policy risk handled in phase 2 cloud-smoke; fallback documented).
- **monitoring**: notification channel (email — Terraform-created email channels start UNVERIFIED and silently drop notifications; verification is the **single documented exception to no-console-clicks**, logged as such in DECISIONS.md with the automatable alternatives — imported pre-verified channel or webhook channel — noted); alert policies via **PromQL** (`condition_prometheus_query_language` — MQL is deprecated since 2025, PromQL is the current-practice signal): 5xx ratio >5 % over 5 min on `run_googleapis_com:request_count`, eval-latency p99 >250 ms, uptime check on `/healthz` + alert; dashboard (`google_monitoring_dashboard` templatefile): eval latency p50/95/99, evals/sec by tenant, error rate by endpoint, cache hit ratio, instance count, SQL CPU.

envs: staging `min_instances=1` (demo env — metrics + no cold-start for evaluator), production `min_instances=1`, deletion protection on prod, separate state prefixes + tfvars.

## 9. CI/CD (GitHub Actions)

**ci.yml** (PRs + main): lint (eslint/prettier/tsc) → test (unit+integration vs `services:` postgres+redis; `jest --coverage`, threshold 80 % lines with `collectCoverageFrom` excluding `main.ts`, `otel.ts`, `realtime/**` — infra-glue exclusions documented) → `npm audit --omit=dev --audit-level=high` → docker build **both targets** (`runtime` → `sha-<git-sha>`, `migrate` → `sha-<git-sha>-migrate`) + OCI labels → Trivy scans **both images** (fail HIGH/CRITICAL — one scanner, no redundant osv-scanner) → **terraform fmt -check + validate** on modules + both env roots, initialized with `terraform init -backend=false` (CI has no state-bucket access by design — validate needs none) → push both tags to Artifact Registry on main (WIF). Deploy workflows point migrate jobs at the `-migrate` tag.

**deploy-staging.yml** (on ci success @ main): WIF auth → update+execute migrate job (`--wait`) → deploy 100 % → **self-sufficient smoke**: fetch admin token from Secret Manager via gcloud → create throwaway tenant + boolean flag → enable at 100 % → evaluate → assert value + reason → archive tenant's flag → cleanup. No credentials in repo; smoke exercises auth+CRUD+audit+evaluate end-to-end on every deploy.

**deploy-production.yml** (manual dispatch, input: image tag):
1. update + execute prod migrate job (`--wait`) — **migrations run in prod too**, before any candidate traffic; migration discipline documented: backward-compatible (expand/contract), so old revision keeps working during the split
2. deploy `--no-traffic`, revision tag `candidate`
3. read candidate URL from `gcloud run services describe --format=json` → `trafficStatuses[] | select(.tag=="candidate") | .uri` (the v2 field; `traffic[]` has no URLs — never hand-construct tagged URLs), poll until reconciled
4. smoke suite (same self-sufficient script) against candidate URL — zero-user-traffic validation
5. shift 10 % → drive ~200 synthetic requests through the main URL (curl loop; a demo service has no organic traffic — deterministic gate, not a vacuous metric query) → failure threshold >1 % → **automated rollback**: `update-traffic --to-revisions <previous>=100`, exit 1
6. healthy → 100 %. Metric-driven bake (Cloud Monitoring query gate) documented as future work — deliberately traded for a deterministic gate that cannot false-promote on empty data.

Rollback story (README + RUNBOOK), stated precisely: rollback is one `update-traffic` command and takes effect in seconds, but a 0 %-traffic revision gets no service-level min instances, so the first requests after rollback may cold-start (~2-4 s) — "fast, not warm". If warm rollback mattered, you'd keep a 1 % split on the old revision during a soak window; documented as the production-grade variant.

## 10. Observability

- **Logs**: nestjs-pino JSON; per-request `request_id`, `tenant_id`, route, latency, status; `severity` mapped; `logging.googleapis.com/trace` from `X-Cloud-Trace-Context` (app logs nest under Cloud Run request logs). `X-Request-ID` echoed; stored on audit rows (log ↔ audit join). **Secret hygiene**: pino `redact` paths for `req.headers["x-api-key"|"x-admin-token"|authorization|cookie]` + `res.headers["set-cookie"]` (pino-http serializes headers by default — unredacted, live API keys would land in Cloud Logging); a unit test asserts the redaction config, and the staging smoke greps its own request logs for the throwaway key to prove absence.
- **Metrics** (OTel meter → Cloud Monitoring exporter, 60 s):
  - `flag_evaluation.duration` histogram (tenant, environment, endpoint) → p50/95/99
  - `flag_evaluations.count`, `http_requests.count` (endpoint, status_class, tenant), `flag_cache.events` (hit|miss)
  - **Known-gotcha hardening baked in**: GCP resource detector + unique `service.instance.id` (boot UUID) → maps to `generic_task`, no multi-instance time-series collisions; `cpu_idle=false` so the 60 s exporter isn't CPU-throttled between requests; `forceFlush` on SIGTERM (Cloud Run 10 s grace). These three lines are README material ("can you operate what you build").
  - **Timebox 45 min**; fallback pre-drafted: Terraform log-based metrics from pino fields (latency distribution, per-tenant counts, cache events) satisfy the custom-metrics + dashboard + alert requirements with near-zero integration risk.
- **Dashboard + alerts**: Terraform (§8); screenshots in README.
- Full OTel tracing: future work (correlation IDs + Cloud Run request logs cover the scope; reasoning stated).

## 11. Security model

- API keys: 32 random bytes → base64url, `ff_` prefix; SHA-256 stored (bcrypt unnecessary for 256-bit random secrets — documented); `api_keys` table → rotation with overlap + revocation (`revoked_at`); RUNBOOK has the rotation procedure.
- Admin token: out-of-band generated, Secret Manager only, `timingSafeEqual(sha256(a), sha256(b))` compare, rotation = new secret version + redeploy.
- Secrets: Secret Manager-backed env vars only; local dev `.env` gitignored + `.env.example`; **no working credential for any deployed URL ever appears in the repo** — demo tenant creds are minted at deploy time and delivered in the submission email, README shows placeholder curl examples + how creds were provisioned.
- **Evaluator access**: submission email carries (a) demo tenant API key and (b) a dedicated evaluator admin token (separate Secret Manager version) so the reviewer can exercise `POST /api/v1/tenants` end-to-end — without it the headline endpoint 401s for them. RUNBOOK: rotate/revoke both after the review window.
- Least privilege: API SA and migrator SA separated (each reads only its own DB secret); deployer SA (run.admin scoped, AR writer, `iam.serviceAccountUser` on both runtime SAs, secret accessor on admin-token secret for smoke, **`roles/logging.viewer` for the smoke log-grep step** — without it `gcloud logging read` 403s), WIF pinned `repo:<owner>/<repo>` + branch; DB app user without DDL, audit INSERT/SELECT only.
- Rate limiting per tenant + per IP on unauthenticated surface (§6). Helmet, body-size limit, class-validator whitelist.
- DB credential rotation (bonus): documented path only (Secret Manager versions + redeploy); implemented if time remains.

## 12. Testing strategy

- **Unit (engine)**: 5 hashing properties + serve-semantics matrix (3 types × 5 states) + targeting operators + variant weights (0 %, 100 %, ≠100 → 422) + invalid default vs type → 422. Plus logger-redaction config test (no secret headers in log output).
- **Integration** (supertest + real PG/Redis): isolation (A's key on B's URLs → 403; evaluate tenant mismatch → 403); env scoping (enabled staging-only → true/false split); audit history old/new correctness; audit UPDATE blocked by trigger; revoked key → 401; rate limit → 429; cache invalidation (evaluate → toggle → evaluate reflects change immediately).
- **Load (k6, `load-test.yml` manual workflow from US runner)**: workflow mints its own throwaway tenant + flags via the admin token (same pattern as smoke — no pre-provisioning dependency), runs against staging whose evaluate limit is set high (see §6); warm-up phase, then ramp 0→50 VUs, hold 2 min, spike 100; thresholds informational (not pass/fail); README table: client RPS + p50/p95/p99, server-side p95/p99 from Cloud Monitoring alongside, cold-start note.
- CI runs unit+integration+coverage on every PR. "With more time": SDK contract tests, mutation testing on engine, Redis-outage chaos test, soak.

## 13. Docker

- **Dockerfile** (four stages — API runtime and migrator are separate targets):
  - `deps`: node:22-slim, `npm ci` (full, incl. prisma CLI)
  - `build`: tsc + `prisma generate`
  - `runtime` (API): node:22-slim + `apt-get install -y --no-install-recommends openssl ca-certificates` (Prisma engine libssl — known slim gotcha, pre-empted), `npm ci --omit=dev` **then COPY the generated client from build** (`node_modules/.prisma` + `node_modules/@prisma/client` — Prisma 6 layout; pruned install alone has no generated client and the app would boot dead); non-root `USER node`, `NODE_ENV=production`, `HEALTHCHECK CMD ["node","-e","fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]` (slim ships no wget/curl), `CMD ["node","dist/main.js"]`
  - `migrate` (migrator image, own tag `sha-<sha>-migrate`): from deps + `prisma/` (schema + migrations) + openssl, `CMD ["npx","prisma","migrate","deploy"]` — Cloud Run migrate jobs use THIS image (prisma CLI is a devDependency; the pruned API image cannot run migrations)
  Phase gate literally checks `docker ps` shows healthy + a local run of the migrate target against compose Postgres succeeds.
- **docker-compose**: api (dev target, bind mount) + postgres:16-alpine (healthcheck) + redis:7-alpine. `make up` = up + migrate + seed (2 demo tenants, sample flags — local only); `make demo` = scripted curl tour (create flag → evaluate → toggle → evaluate shows flip → history).

## 14. Documentation

- **README**: deployed URLs + "demo credentials delivered in submission email" up top; quickstart (3 commands); mermaid architecture + request-flow + ERD; API table + curl examples; evaluation algorithm with worked example (user "42" → bucket 37.2 → in 40 %); caching + invalidation; deployment strategy + rollback walkthrough (exact gcloud commands CI runs); observability (screenshots + the three Cloud Run metric gotchas we pre-empted); security section; testing strategy + k6 table; design decisions (8 numbered entries); assumptions; shortcuts (from DECISIONS.md); future work.
- **docs/RUNBOOK.md**: deploy/promote/rollback procedures, API-key rotation, alert → first-response table, known failure modes (Redis down → degraded, org-policy blocks allUsers → fallback), teardown.
- **DECISIONS.md**: running shortcut log ("production version would …").

## 15. Phase schedule

Estimates are focused solo hours; checkpoints force cuts early instead of at the deadline. Honest total: ~15 h core (test says 8–10; we bias complete+polished and say so in DECISIONS.md; cut list floor ≈ 11 h).

| # | Phase | Est | Done when |
|---|---|---|---|
| 0 | Prereqs (user): GCP project + billing, gcloud auth, GH repo | 0.5 | `gcloud projects describe` OK |
| 1 | Scaffold: Nest, prisma init, compose, healthz/readyz, pino+correlation, Makefile, ci.yml skeleton | 1.0 | `make up` → healthz 200; CI green |
| 2 | **Cloud smoke (de-risk everything)**: bootstrap apply (APIs, state bucket, AR, WIF, secrets script), push skeleton image, hand-deploy to Cloud Run with allUsers, WIF no-op workflow runs green, **kick off `data` module apply** (SQL+Redis provision in background ~20-30 min) | 1.0 | public URL serves healthz; Actions job authed via WIF; org-policy/billing/quota all proven |
| 3 | Schema + migrations + audit trigger + grants + seed (local) | 0.75 | migrate clean; trigger blocks UPDATE |
| 4 | Auth + tenants: keygen/hash, guards (API key, admin, tenant-scope, IP limit) | 1.0 | guard unit tests green |
| 5 | Flags CRUD + audit-in-tx + history + cache invalidation | 1.5 | curl tour works; history shows old/new |
| 6 | Evaluation engine + config cache + tenant rate limit | 1.5 | property tests green; warm bulk eval <5 ms local |
| 7 | Test suite + coverage gate in CI | 1.5 | CI full green |
| 8 | Prod Dockerfile + `make docker-push` + compose polish + `make demo` | 0.75 | image <300 MB, non-root, `docker ps` healthy |
| 9 | Terraform service+monitoring modules; staging fully up with real image | 2.0 | staging URL /readyz 200 (data layer already provisioned in ph2) |
| 10 | CI/CD: deploy-staging (self-sufficient smoke), deploy-production (migrate → candidate → canary → auto-rollback), tf validate in ci; **kick off production tf apply at top of phase** (provisioning overlaps 10-12) | 1.5 | push→staging auto-deploy; canary flow validated end-to-end against staging (incl. deliberate failure → rollback) |
| 11 | Observability: OTel (45-min timebox → fallback log-based), dashboard, alerts, uptime check, verify notification channel | 1.5 | dashboard live during traffic; test alert fires |
| 12 | k6 via load-test.yml; record numbers | 0.5 | README table filled |
| 13 | Docs: README, RUNBOOK, DECISIONS, screenshots | 1.5 | clean-clone dry run of setup works |
| 14 | Prod deploy via full canary workflow (migrate + candidate + 10 %→100 %) + demo tenant + evaluator admin token + submission checklist | 0.75 | prod URL live through the canary path; checklist ✓ |
| 15 | Bonus (only if 0-14 done): SSE via Redis pub/sub | 1.0 | toggle in A appears in `curl -N` B |

**Checkpoints / cut list (pre-committed):**
- CP1 end of phase 8: if >1.5 h behind → drop SSE now. (String variant selection is a core requirement — never on the cut list; the minimal weighted-pick implementation stays.)
- CP2 end of phase 10: if canary gate fighting → simplify prod deploy to smoke-then-promote (keep candidate tag + rollback command demo); if still behind → drop separate prod env, **retarget the canary workflow at staging** (traffic-split requirement still demonstrated in Actions history), README documents staging=demo.
- CP3 phase 11: OTel timebox 45 min → log-based metrics.
- Last resorts, in order: dashboard breadth (keep 4 charts) → IP rate limiter (document) → history pagination.

## 16. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Org policy blocks `allUsers` | Proven in phase 2 (hour ~2). Fallback: keep auth'd invoker + document ID-token curl for evaluator + note in RUNBOOK |
| SQL/Redis provisioning slow | Started in phase 2; overlaps phases 3-8 |
| WIF misconfig | No-op WIF workflow proven in phase 2 |
| OTel exporter fights | 3 known fixes pre-baked (detector, instance-id, cpu always-on); 45-min timebox; log-based fallback pre-drafted |
| TF ↔ CI image drift | `ignore_changes` on image from day one |
| Prisma on slim | openssl+ca-certificates in Dockerfile from day one; phase 8 gate verifies |
| Canary gate flaky | Deterministic synthetic-traffic gate, no metric queries in the deploy path |
| Credit burn | smallest tiers; min_instances=1 only ×2 services; teardown target; est <$8/day |
| Time overrun | CP1-CP3 pre-committed cuts; DECISIONS.md logs each (itself graded) |

## 17. Submission checklist

- [ ] Repo public (or asif@bizscout.com invited); README top: prod URL + staging URL + "creds in email"
- [ ] Fresh clone → `make up` → `make demo` works
- [ ] CI green; Actions history shows canary deploy + one demonstrated rollback
- [ ] Demo tenant minted; demo API key + evaluator admin token + ready-to-run curl block in submission email
- [ ] Dashboard + alert screenshots embedded; k6 table filled
- [ ] `docker ps` shows healthy container locally
- [ ] All 7 PDF deliverables checked against docs/REQUIREMENTS.md
