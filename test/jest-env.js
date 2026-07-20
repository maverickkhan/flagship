// Keep test output readable: pino-http writes straight to stdout otherwise.
process.env.LOG_LEVEL = process.env.LOG_LEVEL_TEST ?? 'silent';
process.env.LOG_PRETTY = 'false';

// Fresh-clone defaults matching docker-compose's host ports — integration
// tests work with `make up` + `make test-integration`, no .env required.
// CI overrides these with its service-container endpoints.
process.env.DATABASE_URL ??=
  'postgresql://flagship:flagship@localhost:5434/flagship?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6380';
process.env.ADMIN_TOKEN ??= 'local-dev-admin-token';
