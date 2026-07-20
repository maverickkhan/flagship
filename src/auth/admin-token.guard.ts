import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { config } from '../config';
import { safeEqual } from './api-key.util';

/**
 * Guards platform-operator endpoints (tenant registration). The token is a
 * bootstrap secret sourced from Secret Manager in cloud environments
 * (documented assumption: registering a tenant is an operator action).
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers['x-admin-token'];
    const token = Array.isArray(header) ? header[0] : header;

    if (!config.adminToken) {
      throw new UnauthorizedException({
        message: 'Admin token not configured',
        code: 'UNAUTHENTICATED',
      });
    }
    if (!token || !safeEqual(token, config.adminToken)) {
      throw new UnauthorizedException({ message: 'Invalid admin token', code: 'UNAUTHENTICATED' });
    }
    return true;
  }
}
