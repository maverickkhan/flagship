import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import {
  ArrayNotEmpty,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { RateLimited, TenantRateLimitGuard } from '../auth/rate-limit.guard';
import { TenantScopeGuard } from '../auth/tenant-scope.guard';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { ENVIRONMENTS } from '../flags/dto';
import type { EnvironmentName } from '../flags/dto';
import { EvaluationService } from './evaluation.service';

export class EvaluateDto {
  @IsUUID()
  tenant_id!: string;

  @IsIn(ENVIRONMENTS as unknown as string[])
  environment!: EnvironmentName;

  @IsString()
  @IsNotEmpty()
  user_id!: string;

  @IsOptional()
  @IsObject()
  context?: Record<string, string | number | boolean>;

  @IsOptional()
  @ArrayNotEmpty()
  @IsString({ each: true })
  flag_keys?: string[];
}

@Controller('api/v1/evaluate')
@UseGuards(ApiKeyGuard, TenantScopeGuard, TenantRateLimitGuard)
@RateLimited('evaluate')
export class EvaluationController {
  constructor(private readonly evaluation: EvaluationService) {}

  @Post()
  evaluate(@Body() dto: EvaluateDto, @Req() req: AuthenticatedRequest) {
    return this.evaluation.evaluate(req.tenant!.id, dto, String(req.id));
  }

  @Post('bulk')
  bulk(@Body() dto: EvaluateDto, @Req() req: AuthenticatedRequest) {
    return this.evaluation.evaluate(req.tenant!.id, { ...dto, flag_keys: undefined }, String(req.id));
  }
}
