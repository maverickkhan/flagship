import { createFlag, createTenant, createTestApp, resetState, TestApp } from './helpers';
import { RealtimeService } from '../src/realtime/realtime.service';
import type { FlagChangeEvent } from '../src/realtime/realtime.service';

describe('realtime flag-change events (e2e)', () => {
  let t: TestApp;
  let tenant: { tenantId: string; apiKey: string };

  beforeAll(async () => {
    t = await createTestApp();
    await resetState(t);
    tenant = await createTenant(t, 'realtime-tenant');
    await createFlag(t, tenant.tenantId, tenant.apiKey, {
      key: 'live-flag',
      name: 'Live flag',
      type: 'boolean',
      default_value: false,
    });
    // Redis pub/sub delivery for the psubscribe handshake.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  afterAll(async () => {
    await t.close();
  });

  it('a toggle published on one connection reaches a subscriber (cross-instance path)', async () => {
    const realtime = t.app.get(RealtimeService);
    const received: FlagChangeEvent[] = [];
    const unsubscribe = realtime.subscribe(tenant.tenantId, 'staging', (e) => received.push(e));

    await t
      .http()
      .put(`/api/v1/tenants/${tenant.tenantId}/flags/live-flag?environment=staging`)
      .set('X-API-Key', tenant.apiKey)
      .send({ enabled: true })
      .expect(200);

    // Round-trips through real Redis pub/sub, not an in-process emitter.
    await new Promise((resolve) => setTimeout(resolve, 300));
    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      flag_key: 'live-flag',
      action: 'flag.updated',
      environment: 'staging',
    });
  });

  it('events are scoped: staging subscriber does not hear production changes', async () => {
    const realtime = t.app.get(RealtimeService);
    const received: FlagChangeEvent[] = [];
    const unsubscribe = realtime.subscribe(tenant.tenantId, 'staging', (e) => received.push(e));

    await t
      .http()
      .put(`/api/v1/tenants/${tenant.tenantId}/flags/live-flag?environment=production`)
      .set('X-API-Key', tenant.apiKey)
      .send({ enabled: true })
      .expect(200);

    await new Promise((resolve) => setTimeout(resolve, 300));
    unsubscribe();
    expect(received).toHaveLength(0);
  });

  it('SSE endpoint rejects a bad environment and requires auth', async () => {
    await t
      .http()
      .get('/api/v1/stream?environment=nope')
      .set('X-API-Key', tenant.apiKey)
      .expect(400);
    await t.http().get('/api/v1/stream?environment=staging').expect(401);
  });
});
