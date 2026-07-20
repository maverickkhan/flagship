# Load test

`evaluate.k6.js` drives the evaluation engine with [k6](https://k6.io):

- **warmup** — 30 s at 5 req/s to fill the Redis flag-config cache.
- **main** — ramp 0→50 VUs over 30 s, hold 2 min, spike to 100 VUs.
- Mix: ~70 % `POST /api/v1/evaluate` (single flag key, hot cache path), ~30 %
  `POST /api/v1/evaluate/bulk`. `user_id` comes from a 100 000-user pool —
  bucketing is deterministic per (tenant, flag, user), so distinct users are
  what exercise both `ROLLOUT_MATCH` and `ROLLOUT_MISS` on a partial rollout;
  the script counts both reasons as custom metrics.
- Thresholds (p95 < 150 ms warm, error rate < 1 %) are **informational** — no
  `abortOnFail`, and CI treats the exit code as advisory. Full metrics land in
  `k6-summary.json`; a compact table prints to the console.

## Run locally (docker-compose)

Prerequisites: `make up` (stack on port 8080, demo tenants seeded) and a k6
binary (`brew install k6`).

The seed prints the demo API key; the tenant UUID is generated, so look it up:

```sh
TENANT_ID=$(docker compose exec -T postgres psql -U flagship -d flagship -tAc \
  "SELECT id FROM tenants WHERE name = 'demo-storefront';")

k6 run \
  -e K6_BASE_URL=http://localhost:8080 \
  -e K6_API_KEY=ff_local_demo_storefront_key_0000000000000000 \
  -e K6_TENANT_ID="$TENANT_ID" \
  -e K6_ENVIRONMENT=staging \
  load-test/evaluate.k6.js
```

`K6_BASE_URL`, `K6_API_KEY`, and `K6_ENVIRONMENT` default to exactly these
values, so only `K6_TENANT_ID` is strictly required. In the seeded `staging`
environment `new-checkout` is enabled at 40 % rollout, so both rollout branches
show up in the counters. (If you run k6 itself in Docker, use
`-e K6_BASE_URL=http://host.docker.internal:8080`.)

## Run in CI (`.github/workflows/load-test.yml`)

Manual `workflow_dispatch` from a US GitHub runner (proximate to
`us-central1`). The workflow is self-sufficient: it fetches the admin token
from Secret Manager, mints a throwaway tenant plus flags (including a partial
rollout), exports `K6_BASE_URL`/`K6_API_KEY`/`K6_TENANT_ID`/`K6_ENVIRONMENT`
for the script, runs k6 against **staging**, uploads `k6-summary.json` as an
artifact, and cleans up the tenant's flags. Threshold breaches do not fail the
job — the numbers are recorded in the README results table instead.

## Why staging doesn't rate-limit the test

Tenant rate limits are per-environment config (`RATE_LIMIT_EVALUATE_PER_MIN`,
plus `RATE_LIMIT_EXEMPT_TENANTS`). Staging runs with a high evaluate limit so
k6 measures the evaluation engine, not the limiter; production keeps 600/min.
Limiter enforcement itself is proven by integration tests and prod config —
see DECISIONS.md.
