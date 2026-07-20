import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { generateApiKey } from '../auth/api-key.util';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(name: string) {
    const generated = generateApiKey();
    try {
      const tenant = await this.prisma.tenant.create({
        data: {
          name,
          apiKeys: {
            create: { keyHash: generated.hash, keyPrefix: generated.prefix },
          },
        },
      });
      return {
        tenant_id: tenant.id,
        name: tenant.name,
        // The full key is returned exactly once; only its sha256 is stored.
        api_key: generated.key,
        environments: ['development', 'staging', 'production'],
      };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({
          message: `Tenant "${name}" already exists`,
          code: 'CONFLICT',
        });
      }
      throw e;
    }
  }
}
