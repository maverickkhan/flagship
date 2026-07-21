import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL',
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code: string | undefined;
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        message = Array.isArray(b.message)
          ? 'Request validation failed'
          : String(b.message ?? message);
        if (Array.isArray(b.message)) details = b.message;
        if (typeof b.code === 'string') code = b.code;
      }
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    // Body-parse failures can reach this filter before the request-id
    // middleware has stamped req.id — the envelope contract holds regardless.
    const requestId = typeof req.id === 'string' ? req.id : randomUUID();
    res.setHeader('X-Request-ID', requestId);
    res.status(status).json({
      error: {
        code: code ?? CODE_BY_STATUS[status] ?? 'ERROR',
        message,
        ...(details !== undefined ? { details } : {}),
      },
      request_id: requestId,
    });
  }
}
