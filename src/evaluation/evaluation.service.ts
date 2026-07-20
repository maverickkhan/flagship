import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { evaluateFlag } from './engine/evaluate';
import type { EvaluationContext } from './engine/types';
import { FlagConfigCacheService } from './flag-config-cache.service';
import type { EvaluateDto } from './evaluation.controller';

@Injectable()
export class EvaluationService {
  private readonly logger = new Logger(EvaluationService.name);

  constructor(private readonly cache: FlagConfigCacheService) {}

  async evaluate(tenantId: string, dto: EvaluateDto, requestId?: string) {
    const startedAt = process.hrtime.bigint();
    const configs = await this.cache.getConfigs(tenantId, dto.environment);
    const context: EvaluationContext = dto.context ?? {};

    let selected = configs.filter((f) => f.status === 'active');
    if (dto.flag_keys) {
      const wanted = new Set(dto.flag_keys);
      const byKey = new Map(configs.map((f) => [f.key, f]));
      const missing = dto.flag_keys.filter((k) => !byKey.has(k));
      if (missing.length > 0) {
        throw new NotFoundException({
          message: `Unknown flag keys: ${missing.join(', ')}`,
          code: 'NOT_FOUND',
        });
      }
      // Explicitly requested archived flags still evaluate (reason FLAG_ARCHIVED);
      // only bulk evaluation excludes them.
      selected = configs.filter((f) => wanted.has(f.key));
    }

    const flags: Record<string, { value: unknown; reason: string }> = {};
    for (const flag of selected) {
      flags[flag.key] = evaluateFlag(tenantId, flag, dto.user_id, context);
    }

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // Structured event feeding the log-based metrics (Terraform
    // google_logging_metric): eval latency distribution + evals/sec by tenant.
    this.logger.log({
      event: 'flag_evaluation',
      tenant_id: tenantId,
      environment: dto.environment,
      duration_ms: Math.round(durationMs * 1000) / 1000,
      flags_evaluated: selected.length,
    });

    return { environment: dto.environment, user_id: dto.user_id, flags, request_id: requestId };
  }
}
