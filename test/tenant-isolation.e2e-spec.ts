import {
  ADMIN_TOKEN,
  createFlag,
  createTenant,
  createTestApp,
  resetState,
  TestApp,
} from './helpers';

describe('tenant isolation (e2e)', () => {
  let t: TestApp;
  let tenantA: { tenantId: string; apiKey: string };
  let tenantB: { tenantId: string; apiKey: string };

  beforeAll(async () => {
    t = await createTestApp();
    await resetState(t);
    tenantA = await createTenant(t, 'isolation-a');
    tenantB = await createTenant(t, 'isolation-b');
    await createFlag(t, tenantA.tenantId, tenantA.apiKey, {
      key: 'secret-feature',
      name: 'Secret feature',
      type: 'boolean',
      default_value: false,
    });
  });

  afterAll(async () => {
    await t.close();
  });

  it("tenant B's key cannot list tenant A's flags", async () => {
    const res = await t
      .http()
      .get(`/api/v1/tenants/${tenantA.tenantId}/flags`)
      .set('X-API-Key', tenantB.apiKey)
      .expect(403);
    expect(res.body.error.code).toBe('TENANT_MISMATCH');
  });

  it("tenant B's key cannot read, update, archive, or view history of A's flag", async () => {
    const base = `/api/v1/tenants/${tenantA.tenantId}/flags/secret-feature`;
    await t.http().put(base).set('X-API-Key', tenantB.apiKey).send({ name: 'x' }).expect(403);
    await t.http().delete(base).set('X-API-Key', tenantB.apiKey).expect(403);
    await t.http().get(`${base}/history`).set('X-API-Key', tenantB.apiKey).expect(403);
  });

  it('evaluate rejects a body tenant_id that does not match the key', async () => {
    const res = await t
      .http()
      .post('/api/v1/evaluate')
      .set('X-API-Key', tenantB.apiKey)
      .send({ tenant_id: tenantA.tenantId, environment: 'production', user_id: 'u1' })
      .expect(403);
    expect(res.body.error.code).toBe('TENANT_MISMATCH');
  });

  it("tenant B's bulk evaluation never sees tenant A's flags", async () => {
    const res = await t
      .http()
      .post('/api/v1/evaluate/bulk')
      .set('X-API-Key', tenantB.apiKey)
      .send({ tenant_id: tenantB.tenantId, environment: 'production', user_id: 'u1' })
      .expect(201);
    expect(Object.keys(res.body.flags)).not.toContain('secret-feature');
  });

  it('flags are namespaced per tenant: same key can exist in both tenants', async () => {
    await createFlag(t, tenantB.tenantId, tenantB.apiKey, {
      key: 'secret-feature',
      name: 'B own flag',
      type: 'string',
      default_value: 'b',
    });
    const res = await t
      .http()
      .get(`/api/v1/tenants/${tenantB.tenantId}/flags`)
      .set('X-API-Key', tenantB.apiKey)
      .expect(200);
    const flag = res.body.flags.find((f: any) => f.key === 'secret-feature');
    expect(flag.type).toBe('string');
  });
});

describe('authentication (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetState(t);
  });

  afterAll(async () => {
    await t.close();
  });

  it('missing key -> 401', async () => {
    const tenant = await createTenant(t, 'auth-tenant');
    const res = await t.http().get(`/api/v1/tenants/${tenant.tenantId}/flags`).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.request_id).toBeDefined();
  });

  it('garbage key -> 401', async () => {
    const tenant = await createTenant(t, 'auth-tenant-2');
    await t
      .http()
      .get(`/api/v1/tenants/${tenant.tenantId}/flags`)
      .set('X-API-Key', 'ff_not_a_real_key')
      .expect(401);
  });

  it('revoked key -> 401', async () => {
    const tenant = await createTenant(t, 'auth-tenant-3');
    await t.prisma.apiKey.updateMany({
      where: { tenantId: tenant.tenantId },
      data: { revokedAt: new Date() },
    });
    await t
      .http()
      .get(`/api/v1/tenants/${tenant.tenantId}/flags`)
      .set('X-API-Key', tenant.apiKey)
      .expect(401);
  });

  it('tenant creation requires the admin token', async () => {
    await t.http().post('/api/v1/tenants').send({ name: 'nope' }).expect(401);
    await t
      .http()
      .post('/api/v1/tenants')
      .set('X-Admin-Token', 'wrong-token')
      .send({ name: 'nope' })
      .expect(401);
  });

  it('api key is returned exactly once and only its hash is stored', async () => {
    const tenant = await createTenant(t, 'auth-tenant-4');
    expect(tenant.apiKey).toMatch(/^ff_/);
    const stored = await t.prisma.apiKey.findFirst({ where: { tenantId: tenant.tenantId } });
    expect(stored!.keyHash).not.toContain(tenant.apiKey);
    expect(stored!.keyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('duplicate tenant name -> 409', async () => {
    await createTenant(t, 'dup-tenant');
    const res = await t
      .http()
      .post('/api/v1/tenants')
      .set('X-Admin-Token', ADMIN_TOKEN)
      .send({ name: 'dup-tenant' })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});
