import { Injectable, NotFoundException } from '@nestjs/common';
import { evaluateFlag } from './engine/evaluate';
import type { EvaluationContext } from './engine/types';
import { FlagConfigCacheService } from './flag-config-cache.service';
import type { EvaluateDto } from './evaluation.controller';

@Injectable()
export class EvaluationService {
  constructor(private readonly cache: FlagConfigCacheService) {}

  async evaluate(tenantId: string, dto: EvaluateDto) {
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

    return { environment: dto.environment, user_id: dto.user_id, flags };
  }
}
