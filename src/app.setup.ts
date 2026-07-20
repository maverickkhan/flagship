import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { HttpExceptionFilter } from './common/http-exception.filter';

/**
 * Shared between main.ts and integration tests so tests exercise the exact
 * production pipeline (pipes, filter, proxy trust).
 */
export function configureApp(app: NestExpressApplication): void {
  // Cloud Run fronts the service with one trusted proxy hop: req.ip resolves
  // to the nearest untrusted X-Forwarded-For entry. Naive leftmost is
  // client-spoofable; blind rightmost can be a proxy IP (PLAN §6).
  app.set('trust proxy', 1);
  app.use(helmet());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();
}
