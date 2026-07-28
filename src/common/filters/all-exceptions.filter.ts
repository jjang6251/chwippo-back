import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as Sentry from '@sentry/nestjs';

const MAX_EXTERNAL_MESSAGE_LEN = 200;

/**
 * LRR P2T1 PR T (M-32): express middleware (bodyParser PayloadTooLargeError 등)가 던지는
 * 4xx err.status/statusCode를 500으로 변환하지 않고 보존. 5xx·status 없음은 generic 500 유지
 * (내부 누수 방어). 외부 message는 200자 cap.
 */
function extractStatus(exception: unknown): number | null {
  if (exception instanceof HttpException) return exception.getStatus();
  if (typeof exception === 'object' && exception !== null) {
    const e = exception as { status?: unknown; statusCode?: unknown };
    const candidate =
      typeof e.status === 'number'
        ? e.status
        : typeof e.statusCode === 'number'
          ? e.statusCode
          : null;
    if (candidate !== null && candidate >= 400 && candidate < 500) {
      return candidate;
    }
  }
  return null;
}

function extractMessage(exception: unknown, status: number): string {
  if (exception instanceof HttpException) return exception.message;
  // 4xx: 클라이언트 에러는 외부 message 노출 OK (단, 길이 cap)
  if (status >= 400 && status < 500) {
    const raw =
      (exception as { message?: unknown })?.message ?? '잘못된 요청입니다.';
    const str = typeof raw === 'string' ? raw : '잘못된 요청입니다.';
    return str.slice(0, MAX_EXTERNAL_MESSAGE_LEN);
  }
  return '서버 오류가 발생했습니다.';
}

/** 5xx 스파이크 감시 훅 (main.ts 에서 app.get 으로 주입 · 없어도 동작) */
export interface Http5xxRecorder {
  record(path: string): void;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly monitor?: Http5xxRecorder) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const preserved = extractStatus(exception);
    const status = preserved ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const message = extractMessage(exception, status);

    if (status >= 500) {
      this.logger.error(exception);
      // 쿼리스트링 제외 — path 만 기록 (OAuth code·state 등이 Discord 로 새지 않도록)
      this.monitor?.record(request.path);
      this.captureToSentry(exception, request.path);
    }

    response
      .status(status)
      .json({ message, statusCode: status, path: request.url });
  }

  /**
   * 5xx 만 Sentry 로 전송한다. 4xx(사용자 입력 실수·권한 없음)는 노이즈이자 quota 낭비.
   *
   * **관측이 서비스를 죽이면 안 된다** — 이 필터는 모든 API 응답이 지나는 길이라
   * Sentry 전송이 throw 하면 전면 장애가 된다. 반드시 삼켜야 한다.
   * DSN 미설정이면 captureException 은 조용히 무시되므로 별도 가드 불필요.
   */
  private captureToSentry(exception: unknown, path: string): void {
    try {
      Sentry.captureException(exception, { tags: { path } });
    } catch (err) {
      this.logger.warn(`Sentry 전송 실패 (무시): ${String(err)}`);
    }
  }
}
