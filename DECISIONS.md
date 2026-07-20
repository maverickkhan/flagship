# DECISIONS.md — running shortcut log

Deliberate shortcuts taken under the take-home timebox, logged as they happen.
Append-only; checkpoint cuts (CP1–CP3 in PLAN.md) get logged here too if taken.
Each entry answers three questions: **what we did**, **why**, and **what the
production-grade version looks like**.

Framing note on the timebox itself: the test estimates 8–10 h; we deliberately
biased toward complete + polished (~15 h of focused work) and say so here rather
than pretending otherwise. The entries below are where we spent *less* than
production would demand, on purpose, to afford that.

---

## 1. Prisma 6.x pinned, not 7

**What we did:** pinned `prisma`/`@prisma/client` to 6.x instead of adopting the
current major (7).

**Why:** Prisma 7 requires driver-adapter wiring and an ESM rewrite of the
application build. Neither buys anything for this service — migrations, the
generated client, and NestJS/CommonJS integration are all mature and boring on
v6 — and the rewiring cost is pure timebox burn with real breakage risk in the
Docker/prisma-generate pipeline.

**Production-grade:** schedule the v7 upgrade as ordinary maintenance — driver
adapter for pg, ESM build migration, re-validate the multi-stage Docker copy of
the generated client — behind CI, on its own branch, with no deadline pressure.

## 2. Email notification channel: one-click verification (the single no-console-clicks exception)

**What we did:** the Cloud Monitoring notification channel is a Terraform-created
**email** channel. Terraform-created email channels start `UNVERIFIED` and
silently drop notifications, so one click on the emailed verification link is
required. This is the single exception to the no-console-clicks rule, logged
here as such.

**Why:** email is the only channel the evaluator can trivially confirm works
without us provisioning third-party infrastructure, and verification is not
automatable for a freshly created email channel.

**Production-grade (fully automatable alternatives, by name):** (a) `terraform
import` of a pre-verified email channel, so Terraform manages a channel that is
already `VERIFIED`; or (b) a **webhook channel** (PagerDuty/Slack/Opsgenie
endpoint), which requires no verification step at all and is what a real on-call
rotation would use anyway.

## 3. Staging rate limits set high for k6

**What we did:** rate limits are per-env config (`RATE_LIMIT_EVALUATE_PER_MIN`
etc.). Staging runs a deliberately high evaluate limit so the k6 load test
measures the evaluation engine and cache, not the rate limiter. Production keeps
the real limit (600 evals/min per tenant). `RATE_LIMIT_EXEMPT_TENANTS` exists as
the surgical alternative.

**Why:** with production limits on, k6 would spend the whole run collecting 429s
and the "throughput + latency" deliverable would describe the limiter, not the
service. Enforcement itself is proven where it belongs: integration tests assert
the 429 + `Retry-After` behavior, and production config keeps the real numbers.

**Production-grade:** a dedicated load-test environment with production-identical
config, using only the exempt-tenant list (never a global limit raise) for load
identities — so the load test exercises the limiter's overhead too.

## 4. Terraform state contains DB/Redis secrets

**What we did:** accepted that the Cloud SQL user password (`google_sql_user`)
and the Memorystore AUTH string (`redis_instance.auth_string`) unavoidably
transit Terraform state. Mitigations: the GCS state bucket's IAM is restricted
to the operator identity only (the CI deployer SA has zero state access), and
the bucket is versioned. The admin token and demo credentials, by contrast,
never touch state — they are created out-of-band by `bootstrap/secrets.sh` and
referenced by name only.

**Why:** these two resources put their secrets in state by design; avoiding it
entirely means abandoning Terraform management of the users, which costs more
than it protects in a single-operator, credit-funded project. Saying this out
loud beats pretending the state file is clean.

**Production-grade:** Cloud SQL **IAM database authentication** (no password in
Terraform at all) or out-of-band user creation with Terraform managing only the
instance; plus customer-managed encryption on the state bucket and short-lived,
audited operator access to it.

## 5. Single GCP project for both environments

**What we did:** staging and production share one GCP project, separated by
name-suffixed resources, separate Terraform roots (`infra/envs/{staging,production}`),
separate state prefixes, and separate tfvars.

**Why:** conserves the $300 credit and avoids a second round of billing/quota
approval lag. Environment separation is still real at the Terraform, naming,
config, and deploy-workflow level — which is the layer this take-home grades.

**Production-grade:** a project per environment (the ideal we deliberately
deviated from): hard IAM blast-radius isolation, per-env quota, per-env billing
visibility, and org-policy differences (e.g. stricter constraints on prod)
expressed at the project boundary.

## 6. CI validates Terraform but never applies it

**What we did:** ci.yml runs `terraform fmt -check` + `validate` on modules and
both env roots (initialized with `-backend=false`); applies are operator-run
(`make tf-apply ENV=<env>`). The deployer SA has no state-bucket access at all.

**Why:** state contains secrets (entry #4), so granting the GitHub identity
state read would be gratuitous privilege — and an auto-applying pipeline is a
bigger deliverable than the timebox affords to do safely (plan artifacts,
approvals, drift detection). Validation-only CI still catches the errors CI can
catch without state.

**Production-grade:** plan-on-PR with the plan posted for review, apply gated
behind a protected environment approval, executed by a dedicated apply identity
with state access — Terraform Cloud/Atlantis-style — plus scheduled drift
detection.

## 7. Deterministic synthetic-traffic canary gate instead of metric-driven bake

**What we did:** the production canary gate is deterministic: after shifting 10%
to the candidate, the workflow drives ~200 synthetic requests through the main
URL and rolls back automatically if the failure ratio exceeds 1%. No Cloud
Monitoring query sits in the deploy path.

**Why:** a demo service has no organic traffic. A metric-driven bake window
would evaluate against empty or near-empty data and could **false-promote on
silence** (no requests → no errors → "healthy"). Deliberately traded: the
synthetic gate cannot be fooled by an empty graph, and it exercises the exact
rollback automation the rubric asks for.

**Production-grade:** with real traffic, a metric-driven bake — hold the split
for N minutes and gate promotion on Cloud Monitoring queries (5xx ratio, latency
p99 deltas vs the stable revision), with the synthetic probe retained as a
smoke floor.

## 8. Coverage gate excludes main.ts, OTel bootstrap, and realtime/

**What we did:** the CI coverage gate (80% lines) uses `collectCoverageFrom`
excluding `main.ts`, `otel.ts`, and `realtime/**`.

**Why:** `main.ts` and `otel.ts` are process-bootstrap glue — measurable only by
booting the process, which the integration suite and the deploy smoke already do
end-to-end; unit-covering them is coverage theater. `realtime/**` is the bonus
SSE surface, built last if at all — leaving it in the denominator would let
optional code fail the gate on required code. The exclusions are declared in CI
config, not hidden.

**Production-grade:** bootstrap covered by real e2e boot tests in CI (container
starts, probes pass, metrics exported); once SSE ships as a supported feature it
enters the gate with its own integration tests (connect, heartbeat, tenant+env
scoped delivery, reconnect).

## 9. Bounded cache staleness under Redis failure (accepted)

**What:** Cache invalidation is an explicit `DEL` after each mutation commit, with a 300s TTL
backstop. Two edges exist: (a) a concurrent cache-miss read can repopulate the key with
pre-mutation config if its DB read raced the commit; (b) if the invalidation `DEL` itself fails
during a Redis blip, stale config stays live. Both are bounded by the TTL — worst case 300s of
stale flags — and the failed-DEL case logs a loud `flag_cache_invalidation_failed` warning.

**Why:** The precise fix (per-tenant version counter embedded in the cache key so stale writes
become unreachable) adds a Redis round-trip to every mutation and more key management for a
window that the TTL already caps at 5 minutes on an internal platform.

**Production-grade:** versioned cache keys (`flagcfg:{tenant}:{env}:{version}`), or Redis
transactions/Lua tying DEL to the DB commit via an outbox.
