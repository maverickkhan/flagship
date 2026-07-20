// Rate-limit env vars must be set before config.ts is imported; jest gives
// each test file a fresh module registry, so this only affects this file.
process.env.RATE_LIMIT_MANAGEMENT_PER_MIN = '5';
process.env.RATE_LIMIT_EVALUATE_PER_MIN = '8';

import { createTenant, createTestApp, resetState, TestApp } from './helpers';

describe('per-tenant rate limiting (e2e)', () => {
  let t: TestApp;
  let tenant: { tenantId: string; apiKey: string };

  beforeAll(async () => {
    t = await createTestApp();
    await resetState(t);
    tenant = await createTenant(t, 'ratelimit-tenant');
  });

  afterAll(async () => {
    await t.close();
  });

  it('management requests over the window limit -> 429 with Retry-After', async () => {
    let limited: any;
    for (let i = 0; i < 7; i++) {
      const res = await t
        .http()
        .get(`/api/v1/tenants/${tenant.tenantId}/flags`)
        .set('X-API-Key', tenant.apiKey);
      if (res.status === 429) {
        limited = res;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(limited).toBeDefined();
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('evaluate limit is independent of the management limit', async () => {
    const results: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await t
        .http()
        .post('/api/v1/evaluate/bulk')
        .set('X-API-Key', tenant.apiKey)
        .send({ tenant_id: tenant.tenantId, environment: 'staging', user_id: `u-${i}` });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 201).length).toBe(8);
    expect(results.filter((s) => s === 429).length).toBe(2);
  });

  it('a second tenant is unaffected by the first tenant exhausting its quota', async () => {
    const other = await createTenant(t, 'ratelimit-neighbor');
    await t
      .http()
      .post('/api/v1/evaluate/bulk')
      .set('X-API-Key', other.apiKey)
      .send({ tenant_id: other.tenantId, environment: 'staging', user_id: 'u' })
      .expect(201);
  });
});
