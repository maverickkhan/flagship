import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { config } from '../config';
import { RedisService } from '../redis/redis.service';
import type { AuthenticatedRequest } from './authenticated-request';

export type RouteClass = 'evaluate' | 'management';
export const ROUTE_CLASS_KEY = 'rate_limit_route_class';
export const RateLimited = (cls: RouteClass) => SetMetadata(ROUTE_CLASS_KEY, cls);

/**
 * Per-tenant fixed-window limiter (noisy-neighbor protection). Fails open
 * when Redis is unavailable: availability of the flag API is worth more than
 * strict quota enforcement for an internal platform (PLAN §6, DECISIONS).
 */
@Injectable()
export class TenantRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(TenantRateLimitGuard.name);

  constructor(
    private readonly redis: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const cls =
      this.reflector.getAllAndOverride<RouteClass>(ROUTE_CLASS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'management';

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const tenantId = req.tenant?.id;
    if (!tenantId || config.rateLimit.exemptTenants.has(tenantId)) return true;

    const limit =
      cls === 'evaluate' ? config.rateLimit.evaluatePerMin : config.rateLimit.managementPerMin;
    const minute = Math.floor(Date.now() / 60000);
    const count = await this.redis.incrWindow(`rl:t:${tenantId}:${cls}:${minute}`, 60);

    if (count === null) {
      this.logger.warn('rate limiter degraded: redis unavailable, failing open');
      return true;
    }
    if (count > limit) {
      res.setHeader('Retry-After', String(60 - (Math.floor(Date.now() / 1000) % 60)));
      throw new HttpException(
        { message: `Rate limit exceeded for ${cls} requests`, code: 'RATE_LIMITED' },
        429,
      );
    }
    return true;
  }
}
