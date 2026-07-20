/**
 * LOCAL DEVELOPMENT ONLY. Seeds two demo tenants with deterministic API keys
 * so `make demo` and manual curl work immediately after `make up`.
 *
 * These keys are valid only against a local docker-compose stack. Cloud
 * environments are never seeded: no credential that works against a deployed
 * URL may exist in this repository (PLAN §11). Cloud smoke tests and demo
 * tenants are minted at deploy time via the admin token.
 */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';

const prisma = new PrismaClient();

const DEMO_TENANTS = [
  {
    name: 'demo-storefront',
    apiKey: 'ff_local_demo_storefront_key_0000000000000000',
  },
  {
    name: 'demo-mobile-app',
    apiKey: 'ff_local_demo_mobile_app_key_00000000000000000',
  },
];

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed.ts is local-only and must never run in production');
  }

  for (const t of DEMO_TENANTS) {
    const tenant = await prisma.tenant.upsert({
      where: { name: t.name },
      update: {},
      create: {
        name: t.name,
        apiKeys: {
          create: {
            keyHash: createHash('sha256').update(t.apiKey).digest('hex'),
            keyPrefix: t.apiKey.slice(0, 10),
          },
        },
      },
    });

    const existing = await prisma.flag.findFirst({ where: { tenantId: tenant.id } });
    if (existing) continue;

    await prisma.flag.create({
      data: {
        tenantId: tenant.id,
        key: 'new-checkout',
        name: 'New checkout flow',
        description: 'Gradual rollout of the rebuilt checkout',
        type: 'boolean',
        defaultValue: false,
        environments: {
          create: [
            { environment: 'development', enabled: true, serveValue: true },
            {
              environment: 'staging',
              enabled: true,
              serveValue: true,
              rolloutPercentage: 40,
            },
            { environment: 'production', enabled: false, serveValue: true },
          ],
        },
      },
    });

    await prisma.flag.create({
      data: {
        tenantId: tenant.id,
        key: 'cta-color',
        name: 'CTA color experiment',
        type: 'string',
        defaultValue: 'blue',
        environments: {
          create: [
            {
              environment: 'development',
              enabled: true,
              serveValue: 'green',
              variants: [
                { value: 'green', weight: 50 },
                { value: 'red', weight: 30 },
                { value: 'blue', weight: 20 },
              ],
            },
            { environment: 'staging', enabled: false, serveValue: 'green' },
            { environment: 'production', enabled: false, serveValue: 'green' },
          ],
        },
      },
    });

    await prisma.flag.create({
      data: {
        tenantId: tenant.id,
        key: 'api-timeout-ms',
        name: 'Downstream API timeout',
        type: 'number',
        defaultValue: 250,
        environments: {
          create: [
            {
              environment: 'development',
              enabled: true,
              serveValue: 500,
              rolloutPercentage: 20,
            },
            { environment: 'staging', enabled: false, serveValue: 500 },
            { environment: 'production', enabled: false, serveValue: 500 },
          ],
        },
      },
    });
  }

  console.log('Seeded demo tenants:');
  for (const t of DEMO_TENANTS) console.log(`  ${t.name}: ${t.apiKey}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
