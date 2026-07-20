import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { config } from '../config';

/**
 * Thin ioredis wrapper with a degraded mode: Redis being down must never take
 * the API down. Cache reads fall through to Postgres and rate limiting fails
 * open (logged + counted) — see PLAN §6.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor() {
    this.client = new Redis(config.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    this.client.on('error', (err) => this.logger.warn(`redis error: ${err.message}`));
  }

  async onModuleDestroy() {
    await this.client.quit().catch(() => this.client.disconnect());
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /** GET that treats any Redis failure as a cache miss. */
  async safeGet(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  /** SETEX that swallows Redis failures. */
  async safeSetex(key: string, ttlSeconds: number, value: string): Promise<void> {
    try {
      await this.client.setex(key, ttlSeconds, value);
    } catch {
      /* degraded mode */
    }
  }

  /** DEL that swallows Redis failures. */
  async safeDel(...keys: string[]): Promise<void> {
    try {
      if (keys.length) await this.client.del(...keys);
    } catch {
      /* degraded mode */
    }
  }

  /**
   * Fixed-window counter: INCR + EXPIRE on first hit.
   * Returns null when Redis is unavailable (callers fail open).
   */
  async incrWindow(key: string, windowSeconds: number): Promise<number | null> {
    try {
      const count = await this.client.incr(key);
      if (count === 1) await this.client.expire(key, windowSeconds);
      return count;
    } catch {
      return null;
    }
  }
}
