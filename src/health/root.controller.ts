import { Controller, Get } from '@nestjs/common';

/**
 * Friendly landing for humans who open the bare service URL in a browser
 * (reviewers included). Everything real lives under /api/v1.
 */
@Controller()
export class RootController {
  @Get()
  root() {
    return {
      service: 'flagship',
      description: 'Multi-tenant configuration & feature flag service',
      health: '/readyz',
      api: {
        evaluate: 'POST /api/v1/evaluate',
        bulk_evaluate: 'POST /api/v1/evaluate/bulk',
        flags: 'GET|POST /api/v1/tenants/{tenantId}/flags (X-API-Key required)',
        stream: 'GET /api/v1/stream?environment= (SSE)',
      },
      docs: 'https://github.com/maverickkhan/flagship#readme',
    };
  }
}
