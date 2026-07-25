import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { Http5xxMonitorService } from './monitoring/http-5xx-monitor.service';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ResponseTransformInterceptor } from './common/interceptors/response-transform.interceptor';

async function bootstrap() {
  // bodyParser: false → 아래서 명시적 limit으로 재설정
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Cloudflare → Railway proxy chain에서 client IP 식별 (ThrottlerGuard용).
  // 2026-07-24 운영 실측으로 chain 확정: [<클라 위조 가능 XFF>, 방문자IP(CF 기록), CF이그레스IP(Railway 기록)]
  // — 1 hop 신뢰 시 req.ip = CF 이그레스(연결마다 변동) → 스로틀 키 분산으로 rate limit 무력.
  // 2 hop = CF가 기록한 방문자 IP 채택. 그 왼쪽(클라이언트 지참 XFF)은 신뢰 안 함 (스푸핑 차단).
  app.set('trust proxy', 2);

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
  // 5xx 스파이크 감시 훅 주입 (DI 싱글톤 · 없어도 필터 동작)
  const http5xxMonitor = app.get(Http5xxMonitorService);
  app.useGlobalFilters(new AllExceptionsFilter(http5xxMonitor));
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
