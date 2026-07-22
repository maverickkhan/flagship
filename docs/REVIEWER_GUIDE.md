# Reviewer guide — the 5-minute tour

Everything below runs against the live production deployment. Credentials (admin token,
demo tenant id + API key) are in the submission email — they are never committed here.

## Fastest path: Postman (2 minutes, zero setup)

Import [`postman/flagship.postman_collection.json`](../postman/flagship.postman_collection.json)
and the environment file next to it, paste the admin token from the email, hit **Run**.
28 requests / 49 assertions execute against production and verify every documented behavior:
tenant registration, flag CRUD, deterministic rollouts, targeting rules, weighted variants,
environment scoping, audit history with pre-images, archive/restore, 401/403/409/422 paths.
Headless alternative:

```bash
npx newman run postman/flagship.postman_collection.json \
  -e postman/production.postman_environment.json \
  --env-var admin_token=<from email>
```

## One curl, if that's all you have time for

```bash
curl -s -X POST https://flagship-production-potbp4ge6a-uc.a.run.app/api/v1/evaluate \
  -H 'X-API-Key: <demo key from email>' -H 'Content-Type: application/json' \
  -d '{"tenant_id":"<demo tenant from email>","environment":"production","user_id":"user-3","context":{}}'
```

Change `user_id` — different users split ~30/70 on the live `checkout-redesign` rollout;
the same user always gets the same answer. That's the deterministic-hashing requirement,
observable.

## Local reproduction (no GCP needed)

```bash
make up      # docker compose: api + postgres + redis, migrated + seeded
make demo    # scripted tour: create flag → evaluate → toggle → re-evaluate → history
make test    # 59 unit tests; make test-integration for 28 e2e (isolation, audit, limits)
```

## Where each rubric area lives

| Area | Look at |
|---|---|
| Backend / data model | `prisma/schema.prisma` + migration SQL (audit trigger, composite FK); `src/flags`, `src/tenants` |
| Evaluation engine | `src/evaluation/engine/` (pure, no I/O) + `*.spec.ts` property tests; algorithm explainer + decision flowchart in README |
| Multi-tenant isolation | `src/auth/` guards; `test/tenant-isolation.e2e-spec.ts`; Postman folder 5 proves it live |
| IaC | `infra/` — bootstrap + 4 modules + 2 env roots, GCS remote state; every screenshot in the README is a Terraform-created resource |
| Canary + rollback | `.github/workflows/deploy-production.yml`; flow diagram + revision screenshot in README; Actions history has three real canary runs |
| Observability | log-based metrics in `infra/modules/monitoring/`; README has live dashboard/alert/uptime screenshots + a real redacted production log line |
| Security | key hashing (`src/auth/api-key.util.ts`), per-tenant + IP rate limits, Secret Manager everywhere, WIF (no SA keys), log redaction |
| Testing | CI runs 87 tests + Trivy + terraform validate on every push; k6 results table in README (local + staging, ~109k requests) |
| Decisions | `DECISIONS.md` — every shortcut with its production-grade alternative; `docs/RUNBOOK.md` — on-call playbook |

## The three-second sanity check

https://flagship-production-potbp4ge6a-uc.a.run.app/readyz → `{"status":"ok","database":true,"redis":true}`
