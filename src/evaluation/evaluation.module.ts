import { Module } from '@nestjs/common';
import { EvaluationController } from './evaluation.controller';
import { EvaluationService } from './evaluation.service';
import { FlagConfigCacheService } from './flag-config-cache.service';

@Module({
  controllers: [EvaluationController],
  providers: [EvaluationService, FlagConfigCacheService],
  exports: [FlagConfigCacheService],
})
export class EvaluationModule {}
