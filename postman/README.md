# Postman collection

A self-contained, fully asserted tour of the live API — 23 requests across health, tenant
registration, flag CRUD, the evaluation engine (determinism, targeting, variants,
environment scoping), audit history, archive/restore, and security (401/403/409/422).

The collection mints its own throwaway tenants, chains their credentials automatically, and
every request carries test assertions — a clean run means every documented behavior was
verified against the deployed service.

## Run in Postman

1. Import `flagship.postman_collection.json` and `production.postman_environment.json`
2. In the environment, set `admin_token` to the value from the submission email
3. Select the environment → open the collection → **Run** (top-to-bottom order matters)

Expected: all requests green, ~60 assertions passing.

## Run headless (newman)

```bash
npx newman run postman/flagship.postman_collection.json \
  -e postman/production.postman_environment.json \
  --env-var admin_token=<ADMIN_TOKEN_FROM_EMAIL>
```

Note: tenant-management requests are rate-limited (120/min) — a normal run uses ~23 requests
and fits comfortably; repeated back-to-back runs may briefly 429.
