import { createFlag, createTenant, createTestApp, resetState, TestApp } from './helpers';

describe('flag lifecycle + audit trail (e2e)', () => {
  let t: TestApp;
  let tenant: { tenantId: string; apiKey: string };

  beforeAll(async () => {
    t = await createTestApp();
    await resetState(t);
    tenant = await createTenant(t, 'lifecycle-tenant');
  });

  afterAll(async () => {
    await t.close();
  });

  const auth = (req: any) => req.set('X-API-Key', tenant.apiKey);

  it('creates a flag with three disabled environments', async () => {
    const flag = await createFlag(t, tenant.tenantId, tenant.apiKey, {
      key: 'checkout-v2',
      name: 'Checkout v2',
      description: 'Rebuilt checkout',
      type: 'boolean',
      default_value: false,
    });
    expect(Object.keys(flag.environments).sort()).toEqual(['development', 'production', 'staging']);
    for (const env of Object.values<any>(flag.environments)) {
      expect(env.enabled).toBe(false);
    }
  });

  it('rejects a default value that does not match the declared type', async () => {
    const res = await auth(t.http().post(`/api/v1/tenants/${tenant.tenantId}/flags`))
      .send({ key: 'bad-flag', name: 'Bad', type: 'number', default_value: 'not-a-number' })
      .expect(422);
    expect(res.body.error.code).toBe('UNPROCESSABLE');
  });

  it('duplicate flag key -> 409', async () => {
    await auth(t.http().post(`/api/v1/tenants/${tenant.tenantId}/flags`))
      .send({ key: 'checkout-v2', name: 'Dup', type: 'boolean', default_value: false })
      .expect(409);
  });

  it('env-scoped fields require ?environment=', async () => {
    const res = await auth(t.http().put(`/api/v1/tenants/${tenant.tenantId}/flags/checkout-v2`))
      .send({ enabled: true })
      .expect(400);
    expect(res.body.error.message).toContain('environment-scoped');
  });

  it('environment scoping: enabling staging leaves production untouched', async () => {
    await auth(
      t.http().put(`/api/v1/tenants/${tenant.tenantId}/flags/checkout-v2?environment=staging`),
    )
      .send({ enabled: true, rollout_percentage: 100 })
      .expect(200);

    const evalIn = async (environment: string) => {
      const res = await auth(t.http().post('/api/v1/evaluate'))
        .send({ tenant_id: tenant.tenantId, environment, user_id: 'u-1' })
        .expect(200);
      return res.body.flags['checkout-v2'];
    };
    expect(await evalIn('staging')).toEqual({ value: true, reason: 'FALLTHROUGH' });
    expect(await evalIn('production')).toEqual({ value: false, reason: 'FLAG_DISABLED' });
  });

  it('cache invalidation: a toggle is visible on the very next evaluation', async () => {
    // Warm the cache…
    await auth(t.http().post('/api/v1/evaluate'))
      .send({ tenant_id: tenant.tenantId, environment: 'staging', user_id: 'u-1' })
      .expect(200);
    // …mutate…
    await auth(
      t.http().put(`/api/v1/tenants/${tenant.tenantId}/flags/checkout-v2?environment=staging`),
    )
      .send({ enabled: false })
      .expect(200);
    // …and the next read must reflect it (explicit DEL, not TTL expiry).
    const res = await auth(t.http().post('/api/v1/evaluate'))
      .send({ tenant_id: tenant.tenantId, environment: 'staging', user_id: 'u-1' })
      .expect(200);
    expect(res.body.flags['checkout-v2'].reason).toBe('FLAG_DISABLED');
  });

  it('archives (soft-delete), excludes from bulk, then restores via status:active', async () => {
    await auth(t.http().delete(`/api/v1/tenants/${tenant.tenantId}/flags/checkout-v2`)).expect(200);

    const bulk = await auth(t.http().post('/api/v1/evaluate/bulk'))
      .send({ tenant_id: tenant.tenantId, environment: 'staging', user_id: 'u-1' })
      .expect(200);
    expect(Object.keys(bulk.body.flags)).not.toContain('checkout-v2');

    const listed = await auth(
      t.http().get(`/api/v1/tenants/${tenant.tenantId}/flags?status=archived`),
    ).expect(200);
    expect(listed.body.flags.map((f: any) => f.key)).toContain('checkout-v2');

    await auth(t.http().put(`/api/v1/tenants/${tenant.tenantId}/flags/checkout-v2`))
      .send({ status: 'active' })
      .expect(200);
    const active = await auth(
      t.http().get(`/api/v1/tenants/${tenant.tenantId}/flags?status=active`),
    ).expect(200);
    expect(active.body.flags.map((f: any) => f.key)).toContain('checkout-v2');
  });

  it('history records every change chronologically with old/new values', async () => {
    const res = await auth(
      t.http().get(`/api/v1/tenants/${tenant.tenantId}/flags/checkout-v2/history`),
    ).expect(200);
    const actions = res.body.history.map((h: any) => h.action);
    expect(actions[0]).toBe('flag.unarchived');
    expect(actions).toEqual(
      expect.arrayContaining(['flag.created', 'flag.updated', 'flag.archived', 'flag.unarchived']),
    );
    const envUpdate = res.body.history.find(
      (h: any) => h.action === 'flag.updated' && h.environment === 'staging' && h.new_value.enabled,
    );
    expect(envUpdate.old_value.enabled).toBe(false);
    expect(envUpdate.new_value.rollout_percentage).toBe(100);
    expect(envUpdate.request_id).toBeDefined();
  });

  it('audit rows are immutable at the database level', async () => {
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "audit_logs" SET actor = 'tampered'`),
    ).rejects.toThrow(/append-only/);
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM "audit_logs"`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('unknown flag key in evaluate -> 404', async () => {
    const res = await auth(t.http().post('/api/v1/evaluate'))
      .send({
        tenant_id: tenant.tenantId,
        environment: 'staging',
        user_id: 'u-1',
        flag_keys: ['does-not-exist'],
      })
      .expect(404);
    expect(res.body.error.message).toContain('does-not-exist');
  });

  it('weighted variants: invalid weights rejected, valid weights evaluated', async () => {
    await createFlag(t, tenant.tenantId, tenant.apiKey, {
      key: 'cta-color',
      name: 'CTA color',
      type: 'string',
      default_value: 'blue',
    });
    await auth(
      t.http().put(`/api/v1/tenants/${tenant.tenantId}/flags/cta-color?environment=staging`),
    )
      .send({
        variants: [
          { value: 'green', weight: 60 },
          { value: 'red', weight: 60 },
        ],
      })
      .expect(422);
    await auth(
      t.http().put(`/api/v1/tenants/${tenant.tenantId}/flags/cta-color?environment=staging`),
    )
      .send({
        enabled: true,
        variants: [
          { value: 'green', weight: 70 },
          { value: 'red', weight: 30 },
        ],
      })
      .expect(200);
    const res = await auth(t.http().post('/api/v1/evaluate'))
      .send({ tenant_id: tenant.tenantId, environment: 'staging', user_id: 'variant-user' })
      .expect(200);
    expect(['green', 'red']).toContain(res.body.flags['cta-color'].value);
  });
});
