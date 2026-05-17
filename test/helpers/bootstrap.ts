/**
 * E2E 부팅 헬퍼 (LRR P2T1 PR P0 인프라).
 *
 * main.ts와 동일한 전역 설정을 적용해 실 운영 흐름과 일치시킨다 —
 * ValidationPipe·AllExceptionsFilter·ResponseTransformInterceptor·JwtAuthGuard·
 * RolesGuard·CORS·helmet·cookieParser·bodyParser·trust proxy.
 *
 * 사용:
 *   const app = await createTestApp();
 *   // ... tests ...
 *   await app.close();
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { ResponseTransformInterceptor } from '../../src/common/interceptors/response-transform.interceptor';

export async function createTestApp(): Promise<NestExpressApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });

  app.set('trust proxy', 1);

  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  });

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.disable('x-powered-by');

  app.use(json({ limit: '256kb' }));
  app.use(urlencoded({ extended: true, limit: '256kb' }));
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) =>
        new BadRequestException(
          errors
            .map((e) =>
              e.constraints
                ? Object.values(e.constraints).join(', ')
                : e.property,
            )
            .join('; '),
        ),
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseTransformInterceptor());

  const reflector = app.get(Reflector);
  app.useGlobalGuards(new JwtAuthGuard(reflector), new RolesGuard(reflector));

  await app.init();
  return app;
}
