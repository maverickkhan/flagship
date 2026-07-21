# Requirements Digest

Source: "CT — Take Home Test — Software Engineer — Backend & Platform — Option C: Feature Flags" (PDF) + Contrarian Thinking job post.
Submission: GitHub repo URL + deployed GCP URL → asif@bizscout.com. Time expectation 8–10 h, complexity 8/10.

## Grading rubric

| Area | Weight | What they probe |
|---|---|---|
| Backend Engineering | 25% | multi-tenant data model, evaluation engine correctness, API design, audit trail, code structure |
| Platform & DevOps | 25% | Terraform quality, GCP service selection + reasoning, blue-green/canary, Docker best practices, secret management |
| Observability | 15% | structured logging, custom metrics, dashboard, alerting — "can you operate what you build" |
| Testing | 15% | evaluation correctness, tenant isolation, load test, CI integration |
| Documentation | 10% | architecture docs, algorithm explainer, trade-offs, setup instructions that actually work |
| Decision Making | 10% | why each choice — GCP services, caching, deployment, framework |

## Functional requirements — Backend (50%)

1. **Tenants**: `POST /api/v1/tenants` registers tenant; each tenant has environments `development|staging|production`; unique API key per tenant.
2. **Flag CRUD**:
   - `POST /api/v1/tenants/{id}/flags` — name, description, type (`boolean|string|number`), default value
   - `GET /api/v1/tenants/{id}/flags` — filter by environment + status (active/archived)
   - `PUT /api/v1/tenants/{id}/flags/{flag_key}` — toggle, rollout %, targeting rules, default value
   - `DELETE /api/v1/tenants/{id}/flags/{flag_key}` — soft delete (archive)
3. **Evaluation engine**:
   - `POST /api/v1/evaluate` — body `{tenant_id, environment, user_id, context}` → evaluated values
   - `POST /api/v1/evaluate/bulk` — all active flags for a context
   - **Deterministic percentage rollout**: same user_id → same value; consistent hashing of `flag_key + user_id` → 0–100 range
   - Types: boolean on/off, string variant selection, percentage gradual rollout
4. **Audit**: every change auto-logged (who, what, when, previous value); `GET .../flags/{flag_key}/history`; append-only/immutable.
5. **Bonus**: SSE or WebSocket per tenant+environment, real-time flag change push.

## Functional requirements — Platform (50%)

1. **IaC (Terraform preferred)**: Compute (Cloud Run/GKE/GCE), Cloud SQL Postgres, Memorystore Redis, VPC/subnets/firewall, least-privilege IAM + SAs, Secret Manager, Cloud Monitoring alert policies + notification channels. Modular, reusable, environment separation.
2. **Containerization**: multi-stage Dockerfile (small, non-root, healthcheck); docker-compose for local dev (API + Postgres + Redis).
3. **Deployment**: blue-green or canary; Cloud Run traffic splitting acceptable path; document strategy + rollback.
4. **CI/CD (GitHub Actions)**: lint → test → build → push Artifact Registry → deploy with traffic splitting; separate staging/production workflows or stages; bonus: automated rollback on health check failure.
5. **Observability**: structured JSON logs + correlation IDs; custom metrics (eval latency p50/p95/p99, evals/sec per tenant, error rate per tenant+endpoint, cache hit/miss); Cloud Monitoring dashboard; alerts (error rate >5% over 5 min, latency threshold, health check failures).
6. **Security**: API keys stored hashed; per-tenant rate limiting (noisy neighbor); all secrets in Secret Manager; bonus: rotated DB credentials.

## Testing requirements

- Unit tests: evaluation engine — percentage rollouts, deterministic hashing, type handling.
- Integration tests: tenant isolation (tenant A cannot touch tenant B), environment scoping.
- Load test (k6/Artillery/autocannon) on evaluate endpoint; document throughput + latency.
- Tests run in CI. Document testing strategy + what you'd add with more time.

## Stack constraints

- Language: **TypeScript preferred** (Python acceptable). Framework: **NestJS recommended**.
- Postgres via Cloud SQL (required), Redis via Memorystore (required), Terraform (preferred), GCP (required), Docker (required), GitHub Actions (required).

## Deliverables checklist

1. Source in Git repo (public or share with asif@bizscout.com)
2. README: setup, architecture + design decisions, tech reasoning, DB schema + data-flow diagrams, API docs with examples, evaluation algorithm explainer, infra architecture + deployment strategy, assumptions/trade-offs, future improvements, testing strategy + load results
3. DB schema + migrations
4. Docker config for local dev
5. Terraform with environment separation
6. GitHub Actions pipelines
7. **Deployed application URL on GCP**

## Priorities inferred from the role description

The role description emphasizes specific practices; this submission treats them as requirements:

- GitHub Actions with **test coverage gates, container + dependency vulnerability scanning, versioned traceable builds** (verbatim from job post)
- Terraform: **reusable modules, remote state with locking**, no console clicks
- **Workload Identity** (their stack: WIF, Secret Manager, IAP, IAM) — no SA key JSON in CI
- **OpenTelemetry** named in their monitoring stack
- Cloud Run vs GKE vs VM — "choosing the right target per service" → defend Cloud Run choice explicitly
- On-call culture: runbooks, postmortems, "never pages twice" → ship a RUNBOOK.md
- "A manual task you've done twice is a bug" → everything scripted/automated
- Explicit anti-signal: over-engineering ("Don't overthink, over-complicate, or over-engineer")
