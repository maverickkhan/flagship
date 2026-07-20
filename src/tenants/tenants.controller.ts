import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { AdminTokenGuard } from '../auth/admin-token.guard';
import { TenantsService } from './tenants.service';

export class CreateTenantDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/, { message: 'name contains invalid characters' })
  name!: string;
}

@Controller('api/v1/tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  // Brute-force protection for the admin token lives in AdminTokenGuard
  // itself (guards run before handlers — a handler-side counter would only
  // ever throttle valid-token callers).
  @Post()
  @UseGuards(AdminTokenGuard)
  create(@Body() dto: CreateTenantDto) {
    return this.tenants.create(dto.name);
  }
}
