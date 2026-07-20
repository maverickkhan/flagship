import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness: the process is up and serving. */
  @Get('healthz')
  healthz() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable. Redis is degraded-tolerable but reported. */
  @Get('readyz')
  async readyz() {
    let database = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = true;
    } catch {
      database = false;
    }
    const redis = await this.redis.ping();
    if (!database) {
      throw new ServiceUnavailableException({ message: 'database unreachable', code: 'NOT_READY' });
    }
    return { status: 'ok', database, redis };
  }
}
