import type { Request } from 'express';

export interface TenantPrincipal {
  id: string;
  name: string;
  keyPrefix: string;
}

export interface AuthenticatedRequest extends Request {
  tenant?: TenantPrincipal;
}
