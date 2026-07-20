import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { loggerParams } from './common/logging';
import { EvaluationModule } from './evaluation/evaluation.module';
import { FlagsModule } from './flags/flags.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { TenantsModule } from './tenants/tenants.module';

@Module({
  imports: [
    LoggerModule.forRoot(loggerParams()),
    PrismaModule,
    RedisModule,
    HealthModule,
    TenantsModule,
    FlagsModule,
    EvaluationModule,
    RealtimeModule,
  ],
})
export class AppModule {}
