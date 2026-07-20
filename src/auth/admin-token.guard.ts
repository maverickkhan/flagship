import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { config } from '../config';
import { RedisService } from '../redis/redis.service';
import { safeEqual } from './api-key.util';

/**
 * Guards platform-operator endpoints (tenant registration). The token is a
 * bootstrap secret sourced from Secret Manager in cloud environments
 * (documented assumption: registering a tenant is an operator action).
 *
 * Brute-force protection lives HERE, not in the route handler: guards run
 * before handlers, so a handler-side counter would never see failed attempts
 * — it would rate-limit only callers presenting the valid token. The window
 * is checked before the compare and incremented on every failure, mirroring
 * ApiKeyGuard's rl:ipfail pattern.
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const failKey = `rl:adminfail:${req.ip}:${Math.floor(Date.now() / 60000)}`;

    const failures = await this.redis.safeGet(failKey);
    if (failures !== null && parseInt(failures, 10) >= config.rateLimit.ipPerMin) {
      throw new HttpException(
        { message: 'Too many failed authentication attempts', code: 'RATE_LIMITED' },
        429,
      );
    }

    const header = req.headers['x-admin-token'];
    const token = Array.isArray(header) ? header[0] : header;

    if (!config.adminToken) {
      throw new UnauthorizedException({
        message: 'Admin token not configured',
        code: 'UNAUTHENTICATED',
      });
    }
    if (!token || !safeEqual(token, config.adminToken)) {
      await this.redis.incrWindow(failKey, 60);
      throw new UnauthorizedException({ message: 'Invalid admin token', code: 'UNAUTHENTICATED' });
    }
    return true;
  }
}
