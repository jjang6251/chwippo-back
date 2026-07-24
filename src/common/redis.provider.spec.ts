import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { redisClientProvider } from './redis.provider';

jest.mock('ioredis');

/**
 * redisClientProvider 단위 spec — 공용 시나리오 ①②.
 * ① REDIS_URL 미설정 → null 반환 + 부팅 warn 1줄 (기존 동작 유지)
 * ② REDIS_URL 설정 → ioredis 인스턴스 생성 (가용성 우선 옵션 · error 핸들러 등록)
 */
describe('redisClientProvider', () => {
  // provider 는 { provide, inject, useFactory } 형태 — useFactory 만 직접 호출
  const factory = (
    redisClientProvider as { useFactory: (c: ConfigService) => Redis | null }
  ).useFactory;

  const makeConfig = (url: string | undefined): ConfigService =>
    ({ get: jest.fn().mockReturnValue(url) }) as unknown as ConfigService;

  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => warnSpy.mockRestore());

  it('① REDIS_URL 미설정 → null + warn 로그, ioredis 미생성', () => {
    const client = factory(makeConfig(undefined));
    expect(client).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(Redis).not.toHaveBeenCalled();
  });

  it('① REDIS_URL 빈 문자열 → null (falsy 취급)', () => {
    const client = factory(makeConfig(''));
    expect(client).toBeNull();
    expect(Redis).not.toHaveBeenCalled();
  });

  it('② REDIS_URL 설정 → ioredis 인스턴스 + 가용성 옵션 + error 핸들러', () => {
    const on = jest.fn();
    const connect = jest.fn().mockResolvedValue(undefined);
    (Redis as unknown as jest.Mock).mockImplementation(() => ({ on, connect }));

    const client = factory(makeConfig('redis://localhost:6379'));

    expect(client).not.toBeNull();
    expect(Redis).toHaveBeenCalledWith(
      'redis://localhost:6379',
      expect.objectContaining({
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      }),
    );
    // 앱이 죽지 않도록 error 는 warn 만 (throw X)
    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
    // 부팅 시 초기 연결 시도 (실패해도 catch)
    expect(connect).toHaveBeenCalled();
  });
});
