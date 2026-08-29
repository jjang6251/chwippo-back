import type Redis from 'ioredis';
import {
  DEDUP_TTL_MS,
  DRAFT_TTL_MS,
  MAX_PENDING_SLOTS,
  PostingDraftStore,
  SLOT_TTL_MS,
} from './posting-draft.store';
import type { CardDraft } from './job-posting-card.rules';

/**
 * 초안 보관소 spec.
 *
 * | 축 | 케이스 |
 * |---|---|
 * | 저장·조회 | 왕복 · 사용자 격리 · 없는 hash → null |
 * | 만료 | 10분 경과 초안은 목록에서 빠진다 |
 * | 중복 방지 | 같은 원문 → 카드 id 기억 · 10분 경과 → 잊음 · 되돌리기 후 강제 망각 |
 * | 슬롯 | 3개까지 · 4번째 실패 · 해제 후 재획득 · stale(2분) 자동 회수 |
 * | Redis | 연결 시 Redis 경로 · **오류 시 메모리 폴백**(클라이언트 보관 아님) |
 * | 되읽기 | 깨진 JSON·모양 불일치 → 조용히 버린다 |
 */
describe('PostingDraftStore', () => {
  const USER = 'user-1';
  const OTHER = 'user-2';
  const HASH = 'a'.repeat(64);

  const draft = (over: Partial<CardDraft> = {}): CardDraft => ({
    companyName: '무신사',
    jobTitle: null,
    jobTitles: ['백엔드 개발자', 'MD'],
    nearProfile: [],
    jobPicked: null,
    companySource: 'parsed',
    deadline: '2026-09-15',
    deadlineKind: 'fixed',
    jobUrl: null,
    steps: [{ name: '서류 접수', date: '2026-09-15', dateHint: null }],
    extraDates: [],
    jobPosting: null,
    orderConflict: false,
    postingYear: null,
    notPosting: false,
    filled: ['companyName'],
    ...over,
  });

  describe('메모리 경로 (REDIS_URL 미설정 — 로컬 dev·CI)', () => {
    let store: PostingDraftStore;
    beforeEach(() => {
      store = new PostingDraftStore(null);
    });

    it('저장한 초안을 hash 로 되찾는다', async () => {
      await store.saveDraft(USER, HASH, 'job', draft());
      const got = await store.getDraft(USER, HASH);
      expect(got?.needs).toBe('job');
      expect(got?.draft.companyName).toBe('무신사');
    });

    it('🔴 다른 사용자의 hash 로는 못 찾는다 (키에 userId 가 들어간다)', async () => {
      await store.saveDraft(USER, HASH, 'job', draft());
      expect(await store.getDraft(OTHER, HASH)).toBeNull();
      expect(await store.listPending(OTHER)).toEqual([]);
    });

    it('10분이 지난 초안은 목록에서 빠진다', async () => {
      const t0 = 1_700_000_000_000;
      await store.saveDraft(USER, HASH, 'company', draft(), t0);
      expect(await store.listPending(USER, t0 + DRAFT_TTL_MS - 1)).toHaveLength(
        1,
      );
      expect(await store.listPending(USER, t0 + DRAFT_TTL_MS)).toHaveLength(0);
    });

    it('삭제하면 목록에서 사라진다 (카드가 만들어졌다는 뜻)', async () => {
      await store.saveDraft(USER, HASH, 'company', draft());
      await store.deleteDraft(USER, HASH);
      expect(await store.listPending(USER)).toEqual([]);
    });

    it('여러 초안은 저장 순서대로 나온다', async () => {
      await store.saveDraft(USER, 'b'.repeat(64), 'job', draft(), 100);
      await store.saveDraft(USER, 'c'.repeat(64), 'company', draft(), 200);
      expect((await store.listPending(USER, 300)).map((p) => p.hash)).toEqual([
        'b'.repeat(64),
        'c'.repeat(64),
      ]);
    });

    describe('같은 원문 중복 방지', () => {
      it('만든 카드 id 를 기억했다가 돌려준다', async () => {
        await store.rememberCard(USER, HASH, 'app-1');
        expect(await store.recallCard(USER, HASH)).toBe('app-1');
      });

      it('10분이 지나면 잊는다 (다시 만들 수 있어야 한다)', async () => {
        const t0 = 1_700_000_000_000;
        await store.rememberCard(USER, HASH, 'app-1', t0);
        expect(await store.recallCard(USER, HASH, t0 + DEDUP_TTL_MS - 1)).toBe(
          'app-1',
        );
        expect(
          await store.recallCard(USER, HASH, t0 + DEDUP_TTL_MS),
        ).toBeNull();
      });

      it('되돌리기 후엔 강제로 잊는다 — 다시 만들기가 정상이다', async () => {
        await store.rememberCard(USER, HASH, 'app-1');
        await store.forgetCard(USER, HASH);
        expect(await store.recallCard(USER, HASH)).toBeNull();
      });

      it('사용자 격리 — 남의 원문 해시로 남의 카드를 못 본다', async () => {
        await store.rememberCard(USER, HASH, 'app-1');
        expect(await store.recallCard(OTHER, HASH)).toBeNull();
      });
    });

    describe('진행 중 슬롯 (동시 3장)', () => {
      it('3개까지 획득하고 4번째는 실패한다', async () => {
        const got: (number | null)[] = [];
        for (let i = 0; i < MAX_PENDING_SLOTS + 1; i++) {
          got.push(await store.acquireSlot(USER));
        }
        expect(got.slice(0, 3)).toEqual([0, 1, 2]);
        expect(got[3]).toBeNull();
      });

      it('해제하면 그 자리를 다시 쓴다', async () => {
        await store.acquireSlot(USER);
        await store.acquireSlot(USER);
        await store.acquireSlot(USER);
        await store.releaseSlot(USER, 1);
        expect(await store.acquireSlot(USER)).toBe(1);
      });

      it('🔴 해제를 못 하고 죽어도 2분 뒤 회수된다 (영구 잠금 방지)', async () => {
        const t0 = 1_700_000_000_000;
        for (let i = 0; i < MAX_PENDING_SLOTS; i++)
          await store.acquireSlot(USER, t0);
        expect(await store.acquireSlot(USER, t0 + SLOT_TTL_MS - 1)).toBeNull();
        expect(await store.acquireSlot(USER, t0 + SLOT_TTL_MS)).toBe(0);
      });

      it('사용자마다 슬롯이 따로다 (한 사람이 남의 자리를 먹지 않는다)', async () => {
        for (let i = 0; i < MAX_PENDING_SLOTS; i++)
          await store.acquireSlot(USER);
        expect(await store.acquireSlot(OTHER)).toBe(0);
      });
    });
  });

  describe('Redis 경로', () => {
    const makeRedis = () => {
      const hash = new Map<string, Map<string, string>>();
      const kv = new Map<string, string>();
      return {
        hset: jest.fn((key: string, field: string, value: string) => {
          const m = hash.get(key) ?? new Map<string, string>();
          m.set(field, value);
          hash.set(key, m);
          return Promise.resolve(1);
        }),
        hgetall: jest.fn((key: string) =>
          Promise.resolve(Object.fromEntries(hash.get(key) ?? new Map())),
        ),
        hdel: jest.fn((key: string, field: string) => {
          hash.get(key)?.delete(field);
          return Promise.resolve(1);
        }),
        pexpire: jest.fn(() => Promise.resolve(1)),
        set: jest.fn((key: string, value: string, ...rest: unknown[]) => {
          if (rest.includes('NX') && kv.has(key)) return Promise.resolve(null);
          kv.set(key, value);
          return Promise.resolve('OK');
        }),
        get: jest.fn((key: string) => Promise.resolve(kv.get(key) ?? null)),
        del: jest.fn((key: string) => {
          kv.delete(key);
          return Promise.resolve(1);
        }),
      };
    };

    it('Redis 가 있으면 Redis 를 쓴다 (해시 자료구조 + PX TTL)', async () => {
      const redis = makeRedis();
      const store = new PostingDraftStore(redis as unknown as Redis);
      await store.saveDraft(USER, HASH, 'job', draft());
      expect(redis.hset).toHaveBeenCalledWith(
        `posting:draft:${USER}`,
        HASH,
        expect.stringContaining('무신사'),
      );
      expect(redis.pexpire).toHaveBeenCalledWith(
        `posting:draft:${USER}`,
        DRAFT_TTL_MS,
      );
      expect((await store.getDraft(USER, HASH))?.needs).toBe('job');
    });

    it('슬롯은 SET NX PX 로 잡는다 (레플리카 간 공유)', async () => {
      const redis = makeRedis();
      const store = new PostingDraftStore(redis as unknown as Redis);
      expect(await store.acquireSlot(USER)).toBe(0);
      expect(redis.set).toHaveBeenCalledWith(
        `posting:slot:${USER}:0`,
        expect.any(String),
        'PX',
        SLOT_TTL_MS,
        'NX',
      );
      expect(await store.acquireSlot(USER)).toBe(1);
    });

    it('🔴 Redis 가 죽으면 **메모리로** 내려간다 — 클라이언트에 초안을 넘기지 않는다', async () => {
      const redis = makeRedis();
      redis.hset.mockRejectedValue(new Error('ECONNREFUSED'));
      redis.hgetall.mockRejectedValue(new Error('ECONNREFUSED'));
      const store = new PostingDraftStore(redis as unknown as Redis);

      await store.saveDraft(USER, HASH, 'company', draft());
      const got = await store.getDraft(USER, HASH);
      expect(got?.draft.companyName).toBe('무신사');
    });

    it('저장된 값이 깨져 있으면 조용히 버린다 (배포 사이 형태 변화 대비)', async () => {
      const redis = makeRedis();
      const store = new PostingDraftStore(redis as unknown as Redis);
      await redis.hset(`posting:draft:${USER}`, HASH, '{깨진 JSON');
      await redis.hset(`posting:draft:${USER}`, 'd'.repeat(64), '{"hash":1}');
      expect(await store.listPending(USER)).toEqual([]);
    });
  });
});
