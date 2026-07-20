import { loggerParams, REDACT_PATHS } from './logging';

describe('log redaction config', () => {
  it('redacts every credential-bearing header', () => {
    // pino-http serializes req/res headers by default: losing any of these
    // paths means live API keys persisted in Cloud Logging.
    expect(REDACT_PATHS).toEqual(
      expect.arrayContaining([
        'req.headers["x-api-key"]',
        'req.headers["x-admin-token"]',
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
      ]),
    );
  });

  it('wires the redact paths into the pino-http config', () => {
    const params = loggerParams();
    expect((params.pinoHttp as any).redact).toEqual({
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    });
  });

  it('echoes or generates X-Request-ID', () => {
    const params = loggerParams();
    const genReqId = (params.pinoHttp as any).genReqId;
    const setHeader = jest.fn();
    const provided = genReqId({ headers: { 'x-request-id': 'given-id' } }, { setHeader });
    expect(provided).toBe('given-id');
    expect(setHeader).toHaveBeenCalledWith('X-Request-ID', 'given-id');
    const generated = genReqId({ headers: {} }, { setHeader });
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });
});
