// Keep test output readable: pino-http writes straight to stdout otherwise.
process.env.LOG_LEVEL = process.env.LOG_LEVEL_TEST ?? 'silent';
process.env.LOG_PRETTY = 'false';
