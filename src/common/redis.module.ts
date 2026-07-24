import {
  Global,
  Inject,
  Module,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { redisClientProvider, REDIS_CLIENT } from './redis.provider';

/**
 * REDIS_CLIENT(ioredis | null) 전역 제공.
 *
 * Throttler(app.module)·LlmService in-flight lock 이 동일한 단일 연결을 공유하도록
 * @Global 로 한 번만 등록한다. REDIS_URL 미설정 시 provider 가 null 을 주입하며,
 * 주입받는 쪽은 @Optional() 로 받아 기존 프로세스 메모리 경로로 폴백한다.
 *
 * onModuleDestroy — app.close() 시 연결을 정리한다 (E2E·graceful shutdown 에서 소켓
 * open handle 이 남아 프로세스가 안 죽는 것을 방지). best-effort: quit 실패 시 강제 disconnect.
 */
@Global()
@Module({
  providers: [redisClientProvider],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis | null = null,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
