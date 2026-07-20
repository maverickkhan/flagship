import { Injectable, Logger } from '@nestjs/common';
import type { Environment } from '@prisma/client';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ENVIRONMENTS } from '../flags/dto';
import type { EvaluableFlag } from './engine/types';

export interface CacheStats {
  hits: number;
  misses: number;
}

/**
 * Caches flag *configs* per (tenant, environment) — not per-user results.
 * Config keyspace is tiny (tenants × 3), invalidation is a precise DEL on
 * every mutation, and evaluation after a hit is pure CPU. Per-user result
 * caching was rejected: users × flags cardinality with imprecise
 * invalidation means stale toggles (PLAN §6, README design decisions).
 */
@Injectable()
export class FlagConfigCacheService {
  private readonly logger = new Logger(FlagConfigCacheService.name);
  readonly stats: CacheStats = { hits: 0, misses: 0 };

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  private key(tenantId: string, environment: string): string {
    return `flagcfg:${tenantId}:${environment}`;
  }

  async getConfigs(tenantId: string, environment: Environment): Promise<EvaluableFlag[]> {
    const cacheKey = this.key(tenantId, environment);
    const cached = await this.redis.safeGet(cacheKey);
    if (cached) {
      this.stats.hits++;
      this.logger.log({ event: 'flag_cache', outcome: 'hit', tenant_id: tenantId });
      return JSON.parse(cached) as EvaluableFlag[];
    }
    this.stats.misses++;
    this.logger.log({ event: 'flag_cache', outcome: 'miss', tenant_id: tenantId });

    const flags = await this.prisma.flag.findMany({
      where: { tenantId },
      include: { environments: { where: { environment } } },
    });

    const configs: EvaluableFlag[] = flags
      .filter((f) => f.environments.length === 1)
      .map((f) => {
        const env = f.environments[0];
        return {
          key: f.key,
          type: f.type,
          status: f.status,
          defaultValue: f.defaultValue as EvaluableFlag['defaultValue'],
          environment: {
            enabled: env.enabled,
            serveValue: env.serveValue as EvaluableFlag['environment']['serveValue'],
            rolloutPercentage: Number(env.rolloutPercentage),
            targetingRules:
              env.targetingRules as unknown as EvaluableFlag['environment']['targetingRules'],
            variants: env.variants as unknown as EvaluableFlag['environment']['variants'],
          },
        };
      });

    await this.redis.safeSetex(
      cacheKey,
      config.cache.flagConfigTtlSeconds,
      JSON.stringify(configs),
    );
    return configs;
  }

  /**
   * Called after every flag mutation commit — all three env keys drop.
   * A failed DEL (Redis blip) leaves stale config live for at most the TTL
   * backstop; that bounded-staleness window is documented in DECISIONS.md,
   * and the failure is logged loudly rather than swallowed.
   */
  async invalidate(tenantId: string): Promise<void> {
    const ok = await this.redis.safeDel(...ENVIRONMENTS.map((env) => this.key(tenantId, env)));
    if (!ok) {
      this.logger.warn({
        event: 'flag_cache_invalidation_failed',
        tenant_id: tenantId,
        message: `cache invalidation DEL failed; stale configs possible for up to ${config.cache.flagConfigTtlSeconds}s`,
      });
    }
  }
}
