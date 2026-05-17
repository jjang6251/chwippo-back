/**
 * AllExceptionsFilter unit spec (LRR P2T1 PR T M-31·M-32).
 *
 * - M-32: express err.status·statusCode 보존 (4xx만, 5xx는 generic 500)
 * - M-31: 응답에 stack trace 미노출 (정보 누수 방어)
 */
import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

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
  const req = { url };
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
});
