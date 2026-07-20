import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { RateLimited, TenantRateLimitGuard } from '../auth/rate-limit.guard';
import { TenantScopeGuard } from '../auth/tenant-scope.guard';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { CreateFlagDto, ENVIRONMENTS, HistoryQuery, ListFlagsQuery, UpdateFlagDto } from './dto';
import type { EnvironmentName } from './dto';
import { FlagsService } from './flags.service';

@Controller('api/v1/tenants/:tenantId/flags')
@UseGuards(ApiKeyGuard, TenantScopeGuard, TenantRateLimitGuard)
@RateLimited('management')
export class FlagsController {
  constructor(private readonly flags: FlagsService) {}

  private actor(req: AuthenticatedRequest): string {
    return `tenant:${req.tenant!.keyPrefix}`;
  }

  private requestId(req: AuthenticatedRequest): string | undefined {
    return typeof req.id === 'string' ? req.id : undefined;
  }

  @Post()
  create(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateFlagDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.flags.create(tenantId, dto, this.actor(req), this.requestId(req));
  }

  @Get()
  list(@Param('tenantId') tenantId: string, @Query() query: ListFlagsQuery) {
    return this.flags.list(tenantId, query);
  }

  @Put(':flagKey')
  update(
    @Param('tenantId') tenantId: string,
    @Param('flagKey') flagKey: string,
    @Query('environment') environment: string | undefined,
    @Body() dto: UpdateFlagDto,
    @Req() req: AuthenticatedRequest,
  ) {
    if (environment !== undefined && !ENVIRONMENTS.includes(environment as EnvironmentName)) {
      throw new BadRequestException({
        message: `environment must be one of ${ENVIRONMENTS.join(', ')}`,
        code: 'VALIDATION_ERROR',
      });
    }
    return this.flags.update(
      tenantId,
      flagKey,
      dto,
      environment as EnvironmentName | undefined,
      this.actor(req),
      this.requestId(req),
    );
  }

  @Delete(':flagKey')
  archive(
    @Param('tenantId') tenantId: string,
    @Param('flagKey') flagKey: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.flags.archive(tenantId, flagKey, this.actor(req), this.requestId(req));
  }

  @Get(':flagKey/history')
  history(
    @Param('tenantId') tenantId: string,
    @Param('flagKey') flagKey: string,
    @Query() query: HistoryQuery,
  ) {
    return this.flags.history(tenantId, flagKey, query);
  }
}
