import { Body, Controller, HttpException, Post, Req, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { AdminTokenGuard } from '../auth/admin-token.guard';
import { config } from '../config';
import { RedisService } from '../redis/redis.service';
import { TenantsService } from './tenants.service';
import type { Request } from 'express';

export class CreateTenantDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/, { message: 'name contains invalid characters' })
  name!: string;
}

@Controller('api/v1/tenants')
export class TenantsController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly redis: RedisService,
  ) {}

  @Post()
  @UseGuards(AdminTokenGuard)
  async create(@Body() dto: CreateTenantDto, @Req() req: Request) {
    // IP fixed-window on the one unauthenticated-by-API-key surface: a static
    // admin token must not be brute-forceable at line rate.
    const minute = Math.floor(Date.now() / 60000);
    const count = await this.redis.incrWindow(`rl:ip:${req.ip}:tenants:${minute}`, 60);
    if (count !== null && count > config.rateLimit.ipPerMin) {
      throw new HttpException({ message: 'Too many requests', code: 'RATE_LIMITED' }, 429);
    }
    return this.tenants.create(dto.name);
  }
}
