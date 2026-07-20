import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

export interface TestApp {
  app: NestExpressApplication;
  prisma: PrismaService;
  redis: RedisService;
  http: () => request.Agent;
  close: () => Promise<void>;
}

export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'local-dev-admin-token';

export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);
  const redis = app.get(RedisService);

  return {
    app,
    prisma,
    redis,
    http: () => request.agent(app.getHttpServer()),
    close: async () => {
      await app.close();
    },
  };
}

/**
 * Full state reset between suites. TRUNCATE bypasses the audit row trigger
 * (row triggers do not fire on TRUNCATE), which is exactly what a test reset
 * needs — and a nice demonstration that the trigger guards DML, not DDL.
 */
export async function resetState(t: TestApp): Promise<void> {
  await t.prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_logs", "flag_environments", "flags", "api_keys", "tenants" RESTART IDENTITY CASCADE',
  );
  try {
    await t.redis.client.flushdb();
  } catch {
    /* redis optional in degraded-mode tests */
  }
}

export async function createTenant(
  t: TestApp,
  name: string,
): Promise<{ tenantId: string; apiKey: string }> {
  const res = await t
    .http()
    .post('/api/v1/tenants')
    .set('X-Admin-Token', ADMIN_TOKEN)
    .send({ name })
    .expect(201);
  return { tenantId: res.body.tenant_id, apiKey: res.body.api_key };
}

export async function createFlag(
  t: TestApp,
  tenantId: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<any> {
  const res = await t
    .http()
    .post(`/api/v1/tenants/${tenantId}/flags`)
    .set('X-API-Key', apiKey)
    .send(body)
    .expect(201);
  return res.body;
}
