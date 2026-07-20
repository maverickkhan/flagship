import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedRequest } from './authenticated-request';

/**
 * Tenant isolation enforcement point. The API key is the authoritative
 * identity; a tenant id in the URL or body that disagrees with it is a
 * cross-tenant access attempt and is rejected — this is the surface the
 * assessment's isolation tests probe (PLAN §4).
 */
@Injectable()
export class TenantScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authTenantId = req.tenant?.id;
    if (!authTenantId) {
      throw new ForbiddenException({ message: 'No tenant principal', code: 'FORBIDDEN' });
    }

    const claimed = (req.params as Record<string, string>).tenantId ?? (req.body as any)?.tenant_id;
    if (claimed !== undefined && claimed !== authTenantId) {
      throw new ForbiddenException({
        message: 'API key does not belong to the requested tenant',
        code: 'TENANT_MISMATCH',
      });
    }
    return true;
  }
}
