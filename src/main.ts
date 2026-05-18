import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ResponseTransformInterceptor } from './common/interceptors/response-transform.interceptor';

async function bootstrap() {
  // bodyParser: false → 아래서 명시적 limit으로 재설정
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Cloudflare → Railway/EC2 proxy chain에서 client IP 식별 (ThrottlerGuard용)
  // prod chain 확정 후 hop 수 조정 가능 (현재 1 hop 가정)
  app.set('trust proxy', 1);

  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  });

  // HTTP 보안 헤더. API 전용이라 CSP·COEP는 비활성, COOP은 cross-origin 허용
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.disable('x-powered-by');

  // 요청 body 크기 제한 (DoS 방어 — 일반 API 호출은 충분히 작음)
  app.use(json({ limit: '256kb' }));
  app.use(urlencoded({ extended: true, limit: '256kb' }));

  app.use(cookieParser());

  const validationLogger = new Logger('ValidationPipe');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => {
        validationLogger.warn(
          `Validation failed: ${JSON.stringify(
            errors.map((e) => ({
              property: e.property,
              constraints: e.constraints,
              value: e.value as unknown,
            })),
          )}`,
        );
        return new BadRequestException(
          errors
            .map((e) =>
              e.constraints
                ? Object.values(e.constraints).join(', ')
                : e.property,
            )
            .join('; '),
        );
      },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseTransformInterceptor());

  const reflector = app.get(Reflector);
  app.useGlobalGuards(new JwtAuthGuard(reflector), new RolesGuard(reflector));

  // LRR Phase 3-A (INF-A1): SIGTERM/SIGINT 시 DB 커넥션·진행 중 요청 정리.
  // Railway·EC2 deploy 시 graceful 셧다운 (in-flight request 완료 후 종료)
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  // LRR Phase 3-A (INF-A3): 부팅 완료 로그 — 포트·환경·시간 명시
  const env = process.env.NODE_ENV ?? 'development';
  Logger.log(`🚀 chwippo-back listening on :${port} (env=${env})`, 'Bootstrap');
}
void bootstrap();
