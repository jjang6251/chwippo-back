import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * 공유 상태(Throttler·in-flight lock)용 단일 Redis 클라이언트.
 *
 * REDIS_URL 은 **옵셔널** — 미설정(로컬 dev·CI) 시 null 을 반환하고 부팅 시 warn 1줄만 남긴다.
 * 이 경우 caller(ThrottlerModule·LlmService)는 기존 프로세스 메모리 경로로 동작한다
 * (단일 레플리카 전제). Railway 멀티 레플리카 운영에서만 REDIS_URL 을 주입한다.
 *
 * 가용성 우선 설계:
 * - lazyConnect + 명시적 connect().catch — Redis 미가동이어도 앱 부팅이 죽지 않음
 * - enableOfflineQueue=false — 끊긴 동안 명령을 큐잉하지 않고 즉시 reject
 *   → caller 가 fail-open(Throttler) / in-memory 폴백(lock) 으로 넘어갈 수 있음
 * - error 이벤트는 warn 로그만 (throw 없음 — 보안장치가 가용성 장애로 번지지 않게)
 */
export const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis | null => {
    const logger = new Logger('RedisProvider');
    const url = config.get<string>('REDIS_URL');
    if (!url) {
      logger.warn(
        'REDIS_URL 미설정 — Throttler·in-flight lock 이 프로세스 메모리로 동작합니다 (단일 레플리카 전제). 멀티 레플리카 운영 시 REDIS_URL 주입 필요.',
      );
      return null;
    }
    const client = new Redis(url, {
      lazyConnect: true, // 부팅 시 연결 실패로 앱이 죽지 않게
      maxRetriesPerRequest: 1, // 명령이 무한 대기하지 않게 (보수적)
      enableOfflineQueue: false, // 끊긴 동안 명령 큐잉 X → 즉시 reject → fail-open/폴백
      retryStrategy: (times) => Math.min(times * 200, 2000), // 재연결 백오프 (상한 2s)
      // Railway 내부망(redis.railway.internal)은 IPv6 전용 — ioredis 기본(IPv4만)이면
      // ENOTFOUND 로 전 명령 실패 → fail-open 상시 발동 (2026-07-24 운영 실측 사고).
      // family 0 = IPv4/IPv6 듀얼 스택 조회. 로컬(localhost)에는 무해.
      family: 0,
    });
    client.on('error', (err) => {
      logger.warn(`Redis 연결 오류 (fail-open·폴백 동작): ${err.message}`);
    });
    client.connect().catch((err: Error) => {
      logger.warn(`Redis 초기 연결 실패 (재연결 예약됨): ${err.message}`);
    });
    return client;
  },
};
