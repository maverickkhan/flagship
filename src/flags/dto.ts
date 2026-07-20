import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export const ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type EnvironmentName = (typeof ENVIRONMENTS)[number];

export class CreateFlagDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9][a-z0-9-_]{1,62}$/, {
    message: 'key must be a slug: lowercase alphanumerics, dashes, underscores, 2-63 chars',
  })
  key!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsIn(['boolean', 'string', 'number'])
  type!: 'boolean' | 'string' | 'number';

  /** Type-checked against `type` in the service (jsonb column). */
  @IsDefined()
  default_value!: unknown;
}

export class UpdateFlagDto {
  // Flag-level fields (no ?environment= param required)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsDefined()
  default_value?: unknown;

  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';

  // Environment-scoped fields (?environment= required)
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsDefined()
  serve_value?: unknown;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  rollout_percentage?: number;

  @IsOptional()
  targeting_rules?: unknown;

  @IsOptional()
  variants?: unknown;
}

export class ListFlagsQuery {
  @IsOptional()
  @IsIn(ENVIRONMENTS as unknown as string[])
  environment?: EnvironmentName;

  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  per_page: number = 20;
}

export class HistoryQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  per_page: number = 50;
}
