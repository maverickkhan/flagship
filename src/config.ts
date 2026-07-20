const int = (v: string | undefined, fallback: number): number => {
  const n = v === undefined ? NaN : parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 8080),
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  adminToken: process.env.ADMIN_TOKEN ?? '',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  logPretty: process.env.LOG_PRETTY === 'true',
  rateLimit: {
    evaluatePerMin: int(process.env.RATE_LIMIT_EVALUATE_PER_MIN, 600),
    managementPerMin: int(process.env.RATE_LIMIT_MANAGEMENT_PER_MIN, 120),
    ipPerMin: int(process.env.RATE_LIMIT_IP_PER_MIN, 60),
    exemptTenants: new Set(
      (process.env.RATE_LIMIT_EXEMPT_TENANTS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  },
  cache: {
    flagConfigTtlSeconds: int(process.env.FLAG_CONFIG_CACHE_TTL_SECONDS, 300),
  },
} as const;

export const isProduction = config.env === 'production';
