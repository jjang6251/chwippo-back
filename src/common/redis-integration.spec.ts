import Redis from 'ioredis';
import { RedisThrottlerStorage } from './redis-throttler.storage';

/**
 * 실 Redis 통합 spec — mock 이 원리적으로 못 보는 사각 검증.
 *
 * mock 은 Lua 스크립트 문법·로직, `SET key val PX <ttl> NX` 인자 순서가 실제 Redis 에서
 * 먹히는지 알 수 없다. fail-open 설계 때문에 이런 오류가 런타임에 조용히 죽을 수 있어
 * CI 에서 진짜 Redis 컨테이너 상대로 확인한다.
 *
 * REDIS_URL 없으면(로컬 기본) 전체 skip — CI(ci.yml redis 서비스)에서만 실행된다.
 *
 * 시나리오:
 * ① Throttler Lua 카운터 — 연속 호출 1→2→3, TTL 첫 호출 설정·유지
 * ② 한도 — limit 5, 6회 → 6번째 isBlocked (스토리지 레벨)
 * ③ TTL 만료 — 짧은 ttl 만료 후 카운터 리셋
 * ④ in-flight lock — SET NX PX 실물: 획득/충돌/DEL 재획득/PX 자동 회수
 *    (LlmService.tryAcquireInFlight·releaseInFlight 와 동일한 명령 형태로 실증)
 * ⑤ 인자 순서 실증 — SET ... PX <ttl> NX 직후 PTTL 이 설정한 TTL 근처인지
 */
const runIntegration = process.env.REDIS_URL ? describe : describe.skip;

runIntegration('Redis integration (real server)', () => {
  // 고유 prefix — CI Redis 오염 방지 (afterAll 에서 이 prefix 키 전부 정리)
  const PREFIX = `citest:${process.pid}:${Date.now()}`;
  const THROTTLER = PREFIX; // storage 는 throttle:<name>:<key> 로 키를 만든다

  let redis: Redis;
  let storage: RedisThrottlerStorage;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL as string, {
      maxRetriesPerRequest: 1,
    });
    await redis.ping(); // 연결 확인 (실패 시 여기서 명확히 터짐)
    storage = new RedisThrottlerStorage(redis);
  });

  afterAll(async () => {
    if (!redis) return;
    const keys = await redis.keys(`*${PREFIX}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it('① Lua 카운터 — 연속 호출 1→2→3, TTL 첫 호출 설정·유지', async () => {
    const key = `${PREFIX}:counter`;
    const r1 = await storage.increment(key, 60000, 100, 60000, THROTTLER);
    expect(r1.totalHits).toBe(1);
    expect(r1.isBlocked).toBe(false);
    // 첫 호출에 TTL 설정 (초 단위 반환)
    expect(r1.timeToExpire).toBeGreaterThan(0);
    expect(r1.timeToExpire).toBeLessThanOrEqual(60);

    const r2 = await storage.increment(key, 60000, 100, 60000, THROTTLER);
    expect(r2.totalHits).toBe(2);

    const r3 = await storage.increment(key, 60000, 100, 60000, THROTTLER);
    expect(r3.totalHits).toBe(3);
    // window 안 — TTL 유지(리셋 안 됨)
    expect(r3.timeToExpire).toBeGreaterThan(0);
    expect(r3.timeToExpire).toBeLessThanOrEqual(60);
  });

  it('② limit=5, 6회 → 6번째 isBlocked (스토리지 레벨)', async () => {
    const key = `${PREFIX}:limit`;
    const records: Awaited<ReturnType<typeof storage.increment>>[] = [];
    for (let i = 0; i < 6; i++) {
      records.push(await storage.increment(key, 60000, 5, 60000, THROTTLER));
    }
    // 1~5번째는 통과
    expect(records.slice(0, 5).every((r) => !r.isBlocked)).toBe(true);
    // 6번째(totalHits=6 > limit=5) 차단
    expect(records[5].isBlocked).toBe(true);
    expect(records[5].totalHits).toBe(6);
    expect(records[5].timeToBlockExpire).toBeGreaterThan(0);
  });

  it('③ 짧은 ttl 만료 후 카운터 리셋', async () => {
    const key = `${PREFIX}:ttl`;
    const r1 = await storage.increment(key, 1000, 100, 1000, THROTTLER);
    expect(r1.totalHits).toBe(1);
    await new Promise((res) => setTimeout(res, 1500)); // ttl 1s 만료 대기 (여유)
    const r2 = await storage.increment(key, 1000, 100, 1000, THROTTLER);
    expect(r2.totalHits).toBe(1); // 리셋됨
  }, 15000);

  it('④ in-flight lock — SET NX PX 실물 (획득/충돌/DEL 재획득/PX 자동 회수)', async () => {
    // LlmService.tryAcquireInFlight 와 동일한 호출 형태: set(key, val, 'PX', ttl, 'NX')
    const key = `${PREFIX}:lock`;

    const first = await redis.set(key, String(Date.now()), 'PX', 60000, 'NX');
    expect(first).toBe('OK'); // 첫 획득 성공

    const second = await redis.set(key, String(Date.now()), 'PX', 60000, 'NX');
    expect(second).toBeNull(); // 이미 잠김 → NX 실패

    await redis.del(key); // releaseInFlight 와 동일
    const third = await redis.set(key, String(Date.now()), 'PX', 60000, 'NX');
    expect(third).toBe('OK'); // DEL 후 재획득 성공
    await redis.del(key);

    // PX 만료 후 자동 회수 (finally 누락·크래시 대비 stale 회수 메커니즘)
    const shortKey = `${PREFIX}:lock-short`;
    const acq = await redis.set(shortKey, '1', 'PX', 200, 'NX');
    expect(acq).toBe('OK');
    await new Promise((res) => setTimeout(res, 500)); // PX 200ms 만료 대기
    const afterExpiry = await redis.set(shortKey, '1', 'PX', 60000, 'NX');
    expect(afterExpiry).toBe('OK'); // 자동 만료 → 재획득 성공
    await redis.del(shortKey);
  }, 15000);

  it('⑤ 인자 순서 실증 — SET ... PX <ttl> NX 직후 PTTL 이 설정한 TTL 근처', async () => {
    const key = `${PREFIX}:pttl`;
    await redis.set(key, '1', 'PX', 5000, 'NX');
    const pttl = await redis.pttl(key);
    // PX 인자가 실제로 먹혔으면 pttl 은 5000 근처 (인자 순서가 틀렸다면 -1[무기한] 이거나 실패)
    expect(pttl).toBeGreaterThan(4000);
    expect(pttl).toBeLessThanOrEqual(5000);
    await redis.del(key);
  });
});
