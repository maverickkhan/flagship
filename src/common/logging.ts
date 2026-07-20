import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Params } from 'nestjs-pino';
import { config, isProduction } from '../config';

const GCP_SEVERITY: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

// Never let credentials reach the log sink: pino-http serializes req/res
// headers by default, so auth material must be redacted here, not by
// convention in call sites.
const REDACT_PATHS = [
  'req.headers["x-api-key"]',
  'req.headers["x-admin-token"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export function loggerParams(): Params {
  return {
    pinoHttp: {
      level: config.logLevel,
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const incoming = req.headers['x-request-id'];
        const id = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
        res.setHeader('X-Request-ID', id);
        return id;
      },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      customAttributeKeys: { reqId: 'request_id' },
      messageKey: 'message',
      formatters: {
        level(label: string) {
          return isProduction ? { severity: GCP_SEVERITY[label] ?? 'INFO' } : { level: label };
        },
      },
      customProps: (req: IncomingMessage) => {
        const props: Record<string, string> = {};
        const tenantId = (req as any).tenant?.id;
        if (tenantId) props.tenant_id = tenantId;
        // Nest app logs under the Cloud Run request log entry.
        const traceHeader = req.headers['x-cloud-trace-context'];
        const project = process.env.GOOGLE_CLOUD_PROJECT;
        if (traceHeader && project && typeof traceHeader === 'string') {
          props['logging.googleapis.com/trace'] =
            `projects/${project}/traces/${traceHeader.split('/')[0]}`;
        }
        return props;
      },
      autoLogging: {
        ignore: (req: IncomingMessage) => req.url === '/healthz' || req.url === '/readyz',
      },
      transport: config.logPretty
        ? { target: 'pino-pretty', options: { singleLine: true } }
        : undefined,
    },
  };
}

export { REDACT_PATHS };
