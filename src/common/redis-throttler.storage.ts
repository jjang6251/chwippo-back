import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type Redis from 'ioredis';

/**
 * @nestjs/throttler v6 ThrottlerStorageRecord 와 구조 동일한 로컬 타입.
 * ThrottlerStorageRecord 는 public entry 에서 re-export 되지 않아 dist/ 깊은 import 를
 * 피하려 여기 선언한다 (구조적 호환이면 implements ThrottlerStorage 성립).
 */
interface ThrottlerRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis 기반 ThrottlerStorage — 레플리카 간 공유 rate-limit 카운터.
 *
 * **왜 직접 구현했나 (@nestjs/throttler-storage-redis 미사용):**
 * - `@nestjs/`-scoped 공식 Redis 스토리지 패키지는 존재하지 않는다 (registry 404).
 * - 커뮤니티 `nestjs-throttler-storage-redis@0.5.1` 의 peerDeps 는 @nestjs/core·common
 *   `^7~10` 으로 캡 — 본 프로젝트는 NestJS 11 이라 --force 없이는 설치 불가(취약).
 * - 무엇보다 fail-open 요구: Redis 런타임 에러 시 요청을 막으면 보안장치가 가용성
 *   장애로 번진다. 패키지는 에러를 그대로 throw 하므로 어차피 래핑이 필요하다.
 * - v6 ThrottlerStorage 인터페이스는 `increment` 단일 메서드라 직접 구현이 더 안전·단순.
 *
 * **fail-open**: eval 실패(연결 끊김·타임아웃 등) 시 "차단 아님" 레코드를 반환하고 warn 만 남긴다.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private static readonly COMMAND = 'chwippoThrottlerIncr';

  /**
   * 원자적 증가 + 블록 판정 Lua 스크립트 (built-in ThrottlerStorageService 의미론 재현).
   * KEYS[1]=hit key, KEYS[2]=block key. ARGV: ttl(ms), limit, blockDuration(ms).
   * 반환: { totalHits, timeToExpire(ms), isBlocked(0|1), timeToBlockExpire(ms) }
   */
  private static readonly LUA = `
    local ttl = tonumber(ARGV[1])
    local limit = tonumber(ARGV[2])
    local blockDuration = tonumber(ARGV[3])

    -- 이미 블록된 상태면 증가하지 않고 블록 잔여시간만 반환
    local blockPttl = redis.call('PTTL', KEYS[2])
    if blockPttl > 0 then
      local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
      return { hits, 0, 1, blockPttl }
    end

    local totalHits = redis.call('INCR', KEYS[1])
    local timeToExpire = redis.call('PTTL', KEYS[1])
    if timeToExpire <= 0 then
      redis.call('PEXPIRE', KEYS[1], ttl)
      timeToExpire = ttl
    end

    local isBlocked = 0
    local timeToBlockExpire = 0
    if totalHits > limit then
      redis.call('SET', KEYS[2], '1', 'PX', blockDuration)
      isBlocked = 1
      timeToBlockExpire = blockDuration
    end

    return { totalHits, timeToExpire, isBlocked, timeToBlockExpire }
  `;

  constructor(private readonly redis: Redis) {
    // defineCommand → EVALSHA(캐시) + NOSCRIPT 자동 폴백. 매 호출 스크립트 재전송 방지.
    this.redis.defineCommand(RedisThrottlerStorage.COMMAND, {
      numberOfKeys: 2,
      lua: RedisThrottlerStorage.LUA,
    });
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerRecord> {
    const hitKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `throttle-block:${throttlerName}:${key}`;
    try {
      const cmd = this.redis as unknown as {
        [RedisThrottlerStorage.COMMAND]: (
          hitKey: string,
          blockKey: string,
          ttl: number,
          limit: number,
          blockDuration: number,
        ) => Promise<[number, number, number, number]>;
      };
      const [totalHits, timeToExpireMs, isBlocked, timeToBlockExpireMs] =
        await cmd[RedisThrottlerStorage.COMMAND](
          hitKey,
          blockKey,
          ttl,
          limit,
          blockDuration,
        );
      return {
        totalHits,
        // built-in 과 동일하게 초 단위로 노출 (Retry-After·X-RateLimit-Reset 헤더용)
        timeToExpire: Math.ceil(timeToExpireMs / 1000),
        isBlocked: isBlocked === 1,
        timeToBlockExpire: Math.ceil(timeToBlockExpireMs / 1000),
      };
    } catch (err) {
      // fail-open — Redis 장애가 요청 차단(=가용성 장애)으로 번지지 않게 통과시킨다.
      this.logger.warn(
        `Redis throttler increment 실패 — fail-open(통과): ${(err as Error).message}`,
      );
      return {
        totalHits: 0,
        timeToExpire: 0,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }

  /**
   * 이 스토리지가 만든 카운터·블록 키 전량 삭제 (e2e 테스트 간 리셋용 —
   * built-in in-memory 스토리지의 `storage.clear()` 대응. 운영 코드 경로에선 미사용).
   */
  async clear(): Promise<void> {
    const keys = await this.redis.keys('throttle:*');
    const blockKeys = await this.redis.keys('throttle-block:*');
    const all = [...keys, ...blockKeys];
    if (all.length > 0) await this.redis.del(...all);
  }
}

/** 전역 rate-limit 설정 — 모든 라우트 공통 (60초·100요청). */
const DEFAULT_THROTTLERS = [{ ttl: 60000, limit: 100 }];

/**
 * ThrottlerModule 옵션 선택 — Redis 있으면 레플리카 간 공유 스토리지, 없으면 기본 in-memory.
 * app.module 의 forRootAsync 팩토리에서 사용. 보안 분기라 단위 테스트 대상으로 분리했다.
 */
export function buildThrottlerOptions(
  redis: Redis | null,
):
  | typeof DEFAULT_THROTTLERS
  | { throttlers: typeof DEFAULT_THROTTLERS; storage: RedisThrottlerStorage } {
  return redis
    ? {
        throttlers: DEFAULT_THROTTLERS,
        storage: new RedisThrottlerStorage(redis),
      }
    : DEFAULT_THROTTLERS;
}
