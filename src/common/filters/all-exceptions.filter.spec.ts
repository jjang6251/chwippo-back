/**
 * AllExceptionsFilter unit spec (LRR P2T1 PR T M-31·M-32).
 *
 * - M-32: express err.status·statusCode 보존 (4xx만, 5xx는 generic 500)
 * - M-31: 응답에 stack trace 미노출 (정보 누수 방어)
 * - Sentry: 5xx만 전송 / 전송 실패가 응답을 깨뜨리지 않음
 */
import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import * as Sentry from '@sentry/nestjs';

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }));
const captureException = Sentry.captureException as jest.Mock;

interface MockResponse {
  status: jest.Mock;
  json: jest.Mock;
  body?: unknown;
  statusCode?: number;
}

function makeHost(url = '/test'): {
  host: ArgumentsHost;
  res: MockResponse;
} {
  const res: MockResponse = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockImplementation(function (this: MockResponse, body) {
      this.body = body;
      return this;
    }),
  };
  // express req.path = 쿼리스트링 제외 경로 (필터가 monitor·Sentry 태그에 쓴다)
  const req = { url, path: url.split('?')[0] };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => req,
    }),
  } as unknown as ArgumentsHost;
  return { host, res };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    captureException.mockReset();
    filter = new AllExceptionsFilter();
    // 5xx 로그 노이즈 차단
    jest
      .spyOn(
        (filter as unknown as { logger: { error: jest.Mock } }).logger,
        'error',
      )
      .mockImplementation(() => {});
  });

  describe('HttpException 처리', () => {
    it('BadRequestException → 400 + 본래 message', () => {
      const { host, res } = makeHost('/x');
      filter.catch(new BadRequestException('잘못된 입력'), host);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.body).toEqual({
        message: '잘못된 입력',
        statusCode: 400,
        path: '/x',
      });
    });

    it('NotFoundException → 404 + 본래 message', () => {
      const { host, res } = makeHost();
      filter.catch(new NotFoundException('없음'), host);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.body).toMatchObject({ statusCode: 404, message: '없음' });
    });

    it('500 HttpException → 500 + logger.error 호출', () => {
      const loggerError = jest.spyOn(
        (filter as unknown as { logger: { error: jest.Mock } }).logger,
        'error',
      );
      const { host } = makeHost();
      filter.catch(
        new HttpException('내부', HttpStatus.INTERNAL_SERVER_ERROR),
        host,
      );
      expect(loggerError).toHaveBeenCalled();
    });
  });

  describe('M-32 — express err.status·statusCode 4xx 보존', () => {
    it('PayloadTooLargeError 형식 (status=413) → 413 + message 보존', () => {
      const { host, res } = makeHost('/upload');
      const err = Object.assign(new Error('request entity too large'), {
        status: 413,
        type: 'entity.too.large',
      });
      filter.catch(err, host);
      expect(res.status).toHaveBeenCalledWith(413);
      expect(res.body).toMatchObject({
        statusCode: 413,
        message: 'request entity too large',
      });
    });

    it('statusCode 필드만 있는 경우도 보존', () => {
      const { host, res } = makeHost();
      const err = Object.assign(new Error('Some 4xx'), { statusCode: 415 });
      filter.catch(err, host);
      expect(res.status).toHaveBeenCalledWith(415);
      expect(res.body).toMatchObject({ statusCode: 415 });
    });

    it('5xx err.status → generic 500 (내부 누수 방어)', () => {
      const { host, res } = makeHost();
      const err = Object.assign(new Error('DB connection lost'), {
        status: 503,
      });
      filter.catch(err, host);
      // 5xx은 status·message 둘 다 generic으로
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.body).toMatchObject({
        statusCode: 500,
        message: '서버 오류가 발생했습니다.',
      });
    });

    it('status 없는 일반 Error → 500 + generic message', () => {
      const { host, res } = makeHost();
      filter.catch(new Error('random failure'), host);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.body).toMatchObject({
        statusCode: 500,
        message: '서버 오류가 발생했습니다.',
      });
    });

    it('4xx message 200자 초과 → cap 적용', () => {
      const { host, res } = makeHost();
      const long = 'a'.repeat(500);
      const err = Object.assign(new Error(long), { status: 400 });
      filter.catch(err, host);
      const body = res.body as { message: string };
      expect(body.message.length).toBe(200);
    });

    it('비-Error 객체 throw (string) → 500 generic', () => {
      const { host, res } = makeHost();
      filter.catch('raw string thrown', host);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.body).toMatchObject({ statusCode: 500 });
    });
  });

  describe('M-31 — 응답에 stack trace 미노출', () => {
    it('HttpException stack 있어도 응답엔 미포함', () => {
      const { host, res } = makeHost();
      filter.catch(new BadRequestException('bad'), host);
      const body = res.body as Record<string, unknown>;
      expect(body).not.toHaveProperty('stack');
      expect(Object.keys(body).sort()).toEqual([
        'message',
        'path',
        'statusCode',
      ]);
    });

    it('일반 Error → stack 미노출 (정보 누수 방어)', () => {
      const { host, res } = makeHost();
      const err = new Error('boom');
      err.stack = 'Error: boom\n    at internal/secret/path.ts:42';
      filter.catch(err, host);
      const body = res.body as Record<string, unknown>;
      expect(body).not.toHaveProperty('stack');
    });

    it('4xx 보존 케이스에도 stack 미노출', () => {
      const { host, res } = makeHost();
      const err = Object.assign(new Error('too large'), { status: 413 });
      filter.catch(err, host);
      const body = res.body as Record<string, unknown>;
      expect(body).not.toHaveProperty('stack');
    });
  });

  describe('경로 보존', () => {
    it('request.url을 응답 path에 포함', () => {
      const { host, res } = makeHost('/users/me/nickname?x=1');
      filter.catch(new BadRequestException('x'), host);
      expect(res.body).toMatchObject({ path: '/users/me/nickname?x=1' });
    });
  });

  describe('Sentry 전송', () => {
    it('5xx → captureException 호출 (기존 logger·monitor 동작 유지)', () => {
      const monitor = { record: jest.fn() };
      const f = new AllExceptionsFilter(monitor);
      jest
        .spyOn(
          (f as unknown as { logger: { error: jest.Mock } }).logger,
          'error',
        )
        .mockImplementation(() => {});

      const { host } = makeHost('/ai/coverletter');
      const err = new Error('boom');
      f.catch(err, host);

      expect(captureException).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledWith(err, {
        tags: { path: '/ai/coverletter' },
      });
      // 기존 경로 회귀 방어 — Sentry 추가가 Discord 스파이크 감시를 대체하지 않는다
      expect(monitor.record).toHaveBeenCalledWith('/ai/coverletter');
    });

    it('4xx → captureException 미호출 (노이즈·quota 낭비 차단)', () => {
      const { host } = makeHost();
      filter.catch(new BadRequestException('잘못된 입력'), host);
      filter.catch(new NotFoundException('없음'), host);
      const tooLarge = Object.assign(new Error('too large'), { status: 413 });
      filter.catch(tooLarge, host);

      expect(captureException).not.toHaveBeenCalled();
    });

    it('태그 path 에 쿼리스트링이 실리지 않는다 (OAuth code 유출 방어)', () => {
      const { host } = makeHost('/auth/kakao/callback?code=SECRET&state=xyz');
      filter.catch(new Error('boom'), host);

      const tags = captureException.mock.calls[0][1] as {
        tags: { path: string };
      };
      expect(tags.tags.path).toBe('/auth/kakao/callback');
      expect(JSON.stringify(captureException.mock.calls[0])).not.toContain(
        'SECRET',
      );
    });

    it('captureException 이 throw 해도 HTTP 응답은 정상 (관측이 서비스를 죽이지 않음)', () => {
      captureException.mockImplementation(() => {
        throw new Error('sentry down');
      });
      jest
        .spyOn(
          (filter as unknown as { logger: { warn: jest.Mock } }).logger,
          'warn',
        )
        .mockImplementation(() => {});

      const { host, res } = makeHost();
      expect(() => filter.catch(new Error('boom'), host)).not.toThrow();
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.body).toMatchObject({
        statusCode: 500,
        message: '서버 오류가 발생했습니다.',
      });
    });
  });
});
