import { Module } from '@nestjs/common';
import { EvaluationModule } from '../evaluation/evaluation.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { FlagsController } from './flags.controller';
import { FlagsService } from './flags.service';

@Module({
  imports: [EvaluationModule, RealtimeModule],
  controllers: [FlagsController],
  providers: [FlagsService],
})
export class FlagsModule {}
