import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Environment, Flag, FlagEnvironment } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FlagConfigCacheService } from '../evaluation/flag-config-cache.service';
import { RealtimeService } from '../realtime/realtime.service';
import { assertTargetingRules, assertValueMatchesType, assertVariants } from './flag-value.util';
import { CreateFlagDto, ENVIRONMENTS, HistoryQuery, ListFlagsQuery, UpdateFlagDto } from './dto';
import type { EnvironmentName } from './dto';

const ENV_SCOPED_FIELDS = [
  'enabled',
  'serve_value',
  'rollout_percentage',
  'targeting_rules',
  'variants',
] as const;

@Injectable()
export class FlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: FlagConfigCacheService,
    private readonly realtime: RealtimeService,
  ) {}

  async create(tenantId: string, dto: CreateFlagDto, actor: string, requestId?: string) {
    const defaultValue = assertValueMatchesType(dto.type, dto.default_value, 'default_value');
    // The ON value starts as the default; boolean flags conventionally start
    // with serve=true so "enable + rollout" behaves as expected out of the box.
    const serveValue = dto.type === 'boolean' ? true : defaultValue;

    try {
      const flag = await this.prisma.$transaction(async (tx) => {
        const created = await tx.flag.create({
          data: {
            tenantId,
            key: dto.key,
            name: dto.name,
            description: dto.description,
            type: dto.type,
            defaultValue: defaultValue as Prisma.InputJsonValue,
            environments: {
              // tenant_id on each row is filled by Prisma via the composite
              // relation (flag_id, tenant_id) -> flags(id, tenant_id).
              create: ENVIRONMENTS.map((environment) => ({
                environment,
                enabled: false,
                serveValue: serveValue as Prisma.InputJsonValue,
              })),
            },
          },
          include: { environments: true },
        });
        await tx.auditLog.create({
          data: {
            tenantId,
            flagId: created.id,
            actor,
            action: 'flag_created',
            newValue: this.flagSnapshot(created) as Prisma.InputJsonValue,
            requestId,
          },
        });
        return created;
      });
      await this.cache.invalidate(tenantId);
      await this.realtime.publish(tenantId, [...ENVIRONMENTS], {
        flag_key: dto.key,
        action: 'flag.created',
      });
      return this.serializeFlag(flag, flag.environments);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({
          message: `Flag "${dto.key}" already exists for this tenant`,
          code: 'CONFLICT',
        });
      }
      throw e;
    }
  }

  async list(tenantId: string, query: ListFlagsQuery) {
    const where: Prisma.FlagWhereInput = { tenantId };
    if (query.status) where.status = query.status;

    const [total, flags] = await this.prisma.$transaction([
      this.prisma.flag.count({ where }),
      this.prisma.flag.findMany({
        where,
        include: {
          environments: query.environment ? { where: { environment: query.environment } } : true,
        },
        orderBy: { createdAt: 'asc' },
        skip: (query.page - 1) * query.per_page,
        take: query.per_page,
      }),
    ]);

    return {
      flags: flags.map((f) => this.serializeFlag(f, f.environments)),
      pagination: { page: query.page, per_page: query.per_page, total },
    };
  }

  async update(
    tenantId: string,
    flagKey: string,
    dto: UpdateFlagDto,
    environment: EnvironmentName | undefined,
    actor: string,
    requestId?: string,
  ) {
    const envFieldsPresent = ENV_SCOPED_FIELDS.filter((f) => dto[f] !== undefined);
    if (envFieldsPresent.length > 0 && !environment) {
      throw new BadRequestException({
        message: `Fields [${envFieldsPresent.join(', ')}] are environment-scoped: pass ?environment=development|staging|production`,
        code: 'VALIDATION_ERROR',
      });
    }

    const flag = await this.findFlagOrThrow(tenantId, flagKey);

    const updated = await this.prisma.$transaction(async (tx) => {
      let result = flag;

      // Flag-level changes
      const flagData: Prisma.FlagUpdateInput = {};
      if (dto.name !== undefined) flagData.name = dto.name;
      if (dto.description !== undefined) flagData.description = dto.description;
      if (dto.default_value !== undefined) {
        flagData.defaultValue = assertValueMatchesType(
          flag.type,
          dto.default_value,
          'default_value',
        ) as Prisma.InputJsonValue;
      }
      if (dto.status !== undefined && dto.status !== flag.status) flagData.status = dto.status;

      if (Object.keys(flagData).length > 0) {
        result = await tx.flag.update({ where: { id: flag.id }, data: flagData });
        const action =
          dto.status === 'archived' && flag.status === 'active'
            ? 'flag_archived'
            : dto.status === 'active' && flag.status === 'archived'
              ? 'flag_unarchived'
              : 'flag_updated';
        await tx.auditLog.create({
          data: {
            tenantId,
            flagId: flag.id,
            actor,
            action,
            oldValue: this.flagSnapshot(flag) as Prisma.InputJsonValue,
            newValue: this.flagSnapshot(result) as Prisma.InputJsonValue,
            requestId,
          },
        });
      }

      // Environment-scoped changes
      if (environment && envFieldsPresent.length > 0) {
        const envState = await tx.flagEnvironment.findUnique({
          where: { flagId_environment: { flagId: flag.id, environment } },
        });
        if (!envState) {
          throw new NotFoundException({
            message: `No ${environment} state for flag "${flagKey}"`,
            code: 'NOT_FOUND',
          });
        }

        const envData: Prisma.FlagEnvironmentUpdateInput = {};
        if (dto.enabled !== undefined) envData.enabled = dto.enabled;
        if (dto.serve_value !== undefined) {
          envData.serveValue = assertValueMatchesType(
            flag.type,
            dto.serve_value,
            'serve_value',
          ) as Prisma.InputJsonValue;
        }
        if (dto.rollout_percentage !== undefined) {
          envData.rolloutPercentage = new Prisma.Decimal(dto.rollout_percentage);
        }
        if (dto.targeting_rules !== undefined) {
          envData.targetingRules = assertTargetingRules(
            flag.type,
            dto.targeting_rules,
          ) as unknown as Prisma.InputJsonValue;
        }
        if (dto.variants !== undefined) {
          const variants = assertVariants(flag.type, dto.variants);
          envData.variants =
            variants === null ? Prisma.DbNull : (variants as unknown as Prisma.InputJsonValue);
        }

        const newEnvState = await tx.flagEnvironment.update({
          where: { flagId_environment: { flagId: flag.id, environment } },
          data: envData,
        });
        await tx.auditLog.create({
          data: {
            tenantId,
            flagId: flag.id,
            actor,
            action: 'flag_updated',
            environment,
            oldValue: this.envSnapshot(envState) as Prisma.InputJsonValue,
            newValue: this.envSnapshot(newEnvState) as Prisma.InputJsonValue,
            requestId,
          },
        });
      }

      return tx.flag.findUniqueOrThrow({
        where: { id: flag.id },
        include: { environments: true },
      });
    });

    await this.cache.invalidate(tenantId);
    await this.realtime.publish(tenantId, environment ? [environment] : [...ENVIRONMENTS], {
      flag_key: flagKey,
      action:
        dto.status === 'archived'
          ? 'flag.archived'
          : dto.status === 'active' && flag.status === 'archived'
            ? 'flag.unarchived'
            : 'flag.updated',
    });
    return this.serializeFlag(updated, updated.environments);
  }

  async archive(tenantId: string, flagKey: string, actor: string, requestId?: string) {
    const flag = await this.findFlagOrThrow(tenantId, flagKey);
    if (flag.status === 'archived') {
      return { flag_key: flagKey, status: 'archived' };
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.flag.update({ where: { id: flag.id }, data: { status: 'archived' } });
      await tx.auditLog.create({
        data: {
          tenantId,
          flagId: flag.id,
          actor,
          action: 'flag_archived',
          oldValue: this.flagSnapshot(flag) as Prisma.InputJsonValue,
          newValue: { ...this.flagSnapshot(flag), status: 'archived' } as Prisma.InputJsonValue,
          requestId,
        },
      });
    });
    await this.cache.invalidate(tenantId);
    await this.realtime.publish(tenantId, [...ENVIRONMENTS], {
      flag_key: flagKey,
      action: 'flag.archived',
    });
    return { flag_key: flagKey, status: 'archived' };
  }

  async history(tenantId: string, flagKey: string, query: HistoryQuery) {
    const flag = await this.findFlagOrThrow(tenantId, flagKey);
    const [total, entries] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where: { flagId: flag.id } }),
      this.prisma.auditLog.findMany({
        where: { flagId: flag.id },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.per_page,
        take: query.per_page,
      }),
    ]);
    return {
      flag_key: flagKey,
      history: entries.map((e) => ({
        id: e.id.toString(),
        actor: e.actor,
        action: e.action.replace('_', '.'),
        environment: e.environment,
        old_value: e.oldValue,
        new_value: e.newValue,
        request_id: e.requestId,
        created_at: e.createdAt.toISOString(),
      })),
      pagination: { page: query.page, per_page: query.per_page, total },
    };
  }

  private async findFlagOrThrow(tenantId: string, flagKey: string): Promise<Flag> {
    const flag = await this.prisma.flag.findUnique({
      where: { tenantId_key: { tenantId, key: flagKey } },
    });
    if (!flag) {
      throw new NotFoundException({ message: `Flag "${flagKey}" not found`, code: 'NOT_FOUND' });
    }
    return flag;
  }

  private flagSnapshot(flag: Flag) {
    return {
      key: flag.key,
      name: flag.name,
      description: flag.description,
      type: flag.type,
      default_value: flag.defaultValue,
      status: flag.status,
    };
  }

  private envSnapshot(env: FlagEnvironment) {
    return {
      environment: env.environment,
      enabled: env.enabled,
      serve_value: env.serveValue,
      rollout_percentage: Number(env.rolloutPercentage),
      targeting_rules: env.targetingRules,
      variants: env.variants,
    };
  }

  private serializeFlag(flag: Flag, environments: FlagEnvironment[]) {
    return {
      id: flag.id,
      key: flag.key,
      name: flag.name,
      description: flag.description,
      type: flag.type,
      default_value: flag.defaultValue,
      status: flag.status,
      created_at: flag.createdAt.toISOString(),
      updated_at: flag.updatedAt.toISOString(),
      environments: Object.fromEntries(
        environments.map((env) => [
          env.environment as Environment,
          {
            enabled: env.enabled,
            serve_value: env.serveValue,
            rollout_percentage: Number(env.rolloutPercentage),
            targeting_rules: env.targetingRules,
            variants: env.variants,
          },
        ]),
      ),
    };
  }
}
