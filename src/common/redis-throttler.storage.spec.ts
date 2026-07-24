import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  buildThrottlerOptions,
  RedisThrottlerStorage,
} from './redis-throttler.storage';

/**
 * RedisThrottlerStorage 단위 spec — Throttler 시나리오 ③④.
 * ③ Redis 스토리지 선택 분기 (buildThrottlerOptions)
 * ④ fail-open — Redis increment 에러 시 요청 통과 (isBlocked=false)
 * + ms→초 변환 · 한도 초과 블록 판정 · 원자적 명령 등록
 */
describe('RedisThrottlerStorage', () => {
  const CMD = 'chwippoThrottlerIncr';

  type FakeRedis = {
    defineCommand: jest.Mock;
    [CMD]?: jest.Mock;
  };

  const makeRedis = (cmd?: jest.Mock): { redis: Redis; fake: FakeRedis } => {
    const fake: FakeRedis = { defineCommand: jest.fn() };
    if (cmd) fake[CMD] = cmd;
    return { redis: fake as unknown as Redis, fake };
  };

  it('생성 시 원자적 Lua 명령을 defineCommand(numberOfKeys:2) 로 등록', () => {
    const { redis, fake } = makeRedis();
    new RedisThrottlerStorage(redis);
    expect(fake.defineCommand).toHaveBeenCalledWith(
      CMD,
      expect.objectContaining({ numberOfKeys: 2 }),
    );
  });

  it('increment 성공 → ms→초 변환 + key 규칙 + 미차단', async () => {
    const cmd = jest.fn().mockResolvedValue([5, 60000, 0, 0]);
    const { redis } = makeRedis(cmd);
    const storage = new RedisThrottlerStorage(redis);

    const rec = await storage.increment(
      '1.2.3.4',
      60000,
      100,
      60000,
      'default',
    );

    expect(rec).toEqual({
      totalHits: 5,
      timeToExpire: 60, // 60000ms → 60s
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(cmd).toHaveBeenCalledWith(
      'throttle:default:1.2.3.4',
      'throttle-block:default:1.2.3.4',
      60000,
      100,
      60000,
    );
  });

  it('한도 초과 → isBlocked=true + block 잔여시간(초)', async () => {
    const cmd = jest.fn().mockResolvedValue([101, 60000, 1, 60000]);
    const { redis } = makeRedis(cmd);
    const storage = new RedisThrottlerStorage(redis);

    const rec = await storage.increment('ip', 60000, 100, 60000, 'default');

    expect(rec.isBlocked).toBe(true);
    expect(rec.timeToBlockExpire).toBe(60);
  });

  it('④ fail-open — Redis 명령 에러 시 통과(isBlocked=false, totalHits=0) + warn', async () => {
    const cmd = jest.fn().mockRejectedValue(new Error('LOADING Redis'));
    const { redis } = makeRedis(cmd);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const storage = new RedisThrottlerStorage(redis);

    const rec = await storage.increment('ip', 60000, 100, 60000, 'default');

    expect(rec).toEqual({
      totalHits: 0,
      timeToExpire: 0,
      isBlocked: false, // 통과 — 가용성 장애로 번지지 않게
      timeToBlockExpire: 0,
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  describe('③ buildThrottlerOptions — 스토리지 선택 분기', () => {
    it('redis 있으면 RedisThrottlerStorage 를 storage 로 사용', () => {
      const { redis } = makeRedis();
      const opts = buildThrottlerOptions(redis);
      expect(Array.isArray(opts)).toBe(false);
      expect(
        (opts as { storage: RedisThrottlerStorage }).storage,
      ).toBeInstanceOf(RedisThrottlerStorage);
    });

    it('redis 없으면 기본 in-memory (throttlers 배열)', () => {
      const opts = buildThrottlerOptions(null);
      expect(Array.isArray(opts)).toBe(true);
      expect(opts).toEqual([{ ttl: 60000, limit: 100 }]);
    });
  });
});
