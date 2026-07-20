import { BadRequestException, Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { TenantScopeGuard } from '../auth/tenant-scope.guard';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { ENVIRONMENTS } from '../flags/dto';
import { RealtimeService, SSE_HEARTBEAT_MS } from './realtime.service';

@Controller('api/v1/stream')
@UseGuards(ApiKeyGuard, TenantScopeGuard)
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  /**
   * SSE stream of flag changes for the authenticated tenant + environment.
   *   curl -N -H "X-API-Key: ..." "$BASE/api/v1/stream?environment=staging"
   * Heartbeat comments every 25s keep intermediaries from closing the idle
   * connection (Cloud Run request timeout is set to 3600s in Terraform).
   */
  @Get()
  stream(
    @Query('environment') environment: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    if (!ENVIRONMENTS.includes(environment as (typeof ENVIRONMENTS)[number])) {
      throw new BadRequestException({
        message: `environment must be one of ${ENVIRONMENTS.join(', ')}`,
        code: 'VALIDATION_ERROR',
      });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`: connected ${new Date().toISOString()}\n\n`);

    const unsubscribe = this.realtime.subscribe(req.tenant!.id, environment, (event) => {
      res.write(`event: flag.change\ndata: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, SSE_HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }
}
