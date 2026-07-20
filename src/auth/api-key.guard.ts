import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { hashApiKey } from './api-key.util';
import type { AuthenticatedRequest } from './authenticated-request';

/**
 * Tenant authentication via X-API-Key. Also the enforcement point for the
 * unauthenticated-surface IP limiter: repeated auth failures from one IP are
 * throttled BEFORE the database lookup, so key-guessing floods cannot become
 * a Postgres exhaustion lever (PLAN §6).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const failKey = `rl:ipfail:${req.ip}:${Math.floor(Date.now() / 60000)}`;
    const failures = await this.redis.safeGet(failKey);
    if (failures !== null && parseInt(failures, 10) >= config.rateLimit.ipPerMin) {
      throw new HttpException(
        { message: 'Too many failed authentication attempts', code: 'RATE_LIMITED' },
        429,
      );
    }

    const header = req.headers['x-api-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (!key) {
      await this.redis.incrWindow(failKey, 60);
      throw new UnauthorizedException({
        message: 'Missing X-API-Key header',
        code: 'UNAUTHENTICATED',
      });
    }

    const apiKey = await this.prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(key) },
      include: { tenant: true },
    });

    if (!apiKey || apiKey.revokedAt) {
      await this.redis.incrWindow(failKey, 60);
      throw new UnauthorizedException({
        message: 'Invalid or revoked API key',
        code: 'UNAUTHENTICATED',
      });
    }

    req.tenant = {
      id: apiKey.tenantId,
      name: apiKey.tenant.name,
      keyPrefix: apiKey.keyPrefix,
    };
    return true;
  }
}
