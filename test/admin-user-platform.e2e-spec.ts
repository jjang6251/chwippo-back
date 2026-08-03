/**
 * 회원 사용 환경(웹/앱) e2e — **N+1 방지가 이 spec 의 존재 이유다.**
 *
 * 🔴 **mock 유닛 spec 으로는 N+1 을 원리적으로 못 잡는다.** repository 를 mock 하면 몇 번을
 * 부르든 즉시 값이 돌아와 테스트가 통과한다. "쿼리가 인원수만큼 나갔는가" 는 **실제 드라이버가
 * 몇 번 호출됐는지**를 세야만 알 수 있다.
 *
 * 그래서 여기서는 DataSource 드라이버를 감싸 **실제 SQL 실행 횟수를 센다.**
 *
 * 시나리오:
 * - 목록: 사용자 1명일 때와 여러 명일 때 **추가 쿼리 수가 같다** (인원수와 무관)
 * - 판정: 앱 UA / 웹 UA / 둘 다 / 이력 없음
 * - 분포: 4분류 합계 = 전체 인원 (로그인 이력 없는 회원도 포함)
 * - 권한: 비인증 401 · 일반 user 403
 */
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { RefreshSession } from '../src/auth/refresh-session.entity';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsAdmin, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

const APP_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 chwippo-mobile-webview/1.0.0';
const WEB_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';

describe('Admin 회원 사용 환경 (e2e)', () => {
  let app: INestApplication<App>;
  let ds: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  afterAll(async () => {
    await cleanAllTestUsers(app);
    await app.close();
  });

  afterEach(async () => {
    await cleanAllTestUsers(app);
  });

  /** 로그인 이력을 직접 심는다 — 실제 로그인 왕복으로는 UA 를 마음대로 줄 수 없다 */
  async function seedSession(userId: string, ua: string | null) {
    await ds.getRepository(RefreshSession).insert({
      id: randomUUID(),
      userId,
      expiresAt: new Date(Date.now() + 86_400_000),
      deviceInfo: ua,
    });
  }

  /**
   * SQL 실행 횟수를 센다.
   *
   * 🔴 `DataSource.query` 만 감시하면 **QueryBuilder 로 나가는 쿼리를 통째로 놓친다** —
   * 둘 다 결국 `QueryRunner.query` 를 거치므로 **프로토타입**에 스파이를 건다.
   */
  async function countQueries<T>(fn: () => Promise<T>): Promise<[T, number]> {
    const runner = ds.createQueryRunner();
    const proto = Object.getPrototypeOf(runner) as {
      query: (...a: never[]) => unknown;
    };
    await runner.release();

    const spy = jest.spyOn(proto, 'query');
    try {
      const out = await fn();
      return [out, spy.mock.calls.length];
    } finally {
      spy.mockRestore();
    }
  }

  describe('GET /admin/users — 목록 뱃지', () => {
    it('사용 환경이 사용자마다 붙는다 (앱 / 웹 / 둘 다 / 없음)', async () => {
      const admin = await signInAsAdmin(app);
      const u1 = await signInAsUser(app, { nickname: 'plat-app' });
      const u2 = await signInAsUser(app, { nickname: 'plat-web' });
      const u3 = await signInAsUser(app, { nickname: 'plat-both' });

      await seedSession(u1.user.id, APP_UA);
      await seedSession(u2.user.id, WEB_UA);
      await seedSession(u3.user.id, APP_UA);
      await seedSession(u3.user.id, WEB_UA);

      const res = await request(app.getHttpServer())
        .get('/admin/users?limit=100')
        .set(bearer(admin.accessToken))
        .expect(200);

      // 전역 인터셉터가 `{ data, message }` 로 감싼다 → 목록 payload 는 `body.data.data`
      const rows = (res.body.data as { data: unknown }).data as Array<{
        id: string;
        platform: { app: boolean; web: boolean };
      }>;
      const byId = new Map(rows.map((r) => [r.id, r.platform]));

      expect(byId.get(u1.user.id)).toMatchObject({ app: true, web: false });
      expect(byId.get(u2.user.id)).toMatchObject({ app: false, web: true });
      expect(byId.get(u3.user.id)).toMatchObject({ app: true, web: true });
    });

    /**
     * 🔴 **이 테스트가 N+1 가드다.**
     * 사용자가 1명일 때와 5명일 때 **쿼리 수가 같아야** 한다. 사용자마다 조회하는 구현으로
     * 바뀌면 5명 쪽이 훨씬 커져 즉시 실패한다.
     */
    it('쿼리 수가 사용자 수와 무관하다 (1명 vs 5명)', async () => {
      const admin = await signInAsAdmin(app);
      const one = await signInAsUser(app, { nickname: 'nplus-1' });
      await seedSession(one.user.id, WEB_UA);

      // ⚠️ 첫 요청은 인증 경로 워밍업으로 쿼리가 더 나간다 — 측정 전에 한 번 태워 편차를 없앤다
      await request(app.getHttpServer())
        .get('/admin/users?limit=100')
        .set(bearer(admin.accessToken))
        .expect(200);

      const [, q1] = await countQueries(async () => {
        await request(app.getHttpServer())
          .get('/admin/users?limit=100')
          .set(bearer(admin.accessToken))
          .expect(200);
      });

      for (let i = 2; i <= 5; i += 1) {
        const u = await signInAsUser(app, { nickname: `nplus-${i}` });
        await seedSession(u.user.id, i % 2 === 0 ? APP_UA : WEB_UA);
      }

      const [, q5] = await countQueries(async () => {
        await request(app.getHttpServer())
          .get('/admin/users?limit=100')
          .set(bearer(admin.accessToken))
          .expect(200);
      });

      expect(q5).toBe(q1);
    });
  });

  describe('GET /admin/platform-distribution', () => {
    /**
     * 🔴 4분류 합계가 전체와 어긋나면 화면이 거짓말을 한다.
     * 특히 **로그인 이력이 없는 회원**이 빠지기 쉽다 (세션 테이블에서 시작하면 통째로 사라진다).
     */
    it('4분류 합계가 전체 인원과 정확히 맞는다', async () => {
      const admin = await signInAsAdmin(app);
      const a = await signInAsUser(app, { nickname: 'dist-app' });
      const w = await signInAsUser(app, { nickname: 'dist-web' });
      const b = await signInAsUser(app, { nickname: 'dist-both' });
      await signInAsUser(app, { nickname: 'dist-none' }); // 세션 이력 없음

      await seedSession(a.user.id, APP_UA);
      await seedSession(w.user.id, WEB_UA);
      await seedSession(b.user.id, APP_UA);
      await seedSession(b.user.id, WEB_UA);

      const res = await request(app.getHttpServer())
        .get('/admin/platform-distribution')
        .set(bearer(admin.accessToken))
        .expect(200);

      const d = res.body.data as {
        total: number;
        both: number;
        appOnly: number;
        webOnly: number;
        none: number;
        appUsers: number;
      };

      expect(d.both + d.appOnly + d.webOnly + d.none).toBe(d.total);
      expect(d.appUsers).toBe(d.appOnly + d.both);
      expect(d.none).toBeGreaterThanOrEqual(1); // 로그인 이력 없는 회원이 집계에 남아 있다
    });

    it('비인증 401 · 일반 user 403', async () => {
      const u = await signInAsUser(app, { nickname: 'plat-guard' });
      await request(app.getHttpServer())
        .get('/admin/platform-distribution')
        .expect(401);
      await request(app.getHttpServer())
        .get('/admin/platform-distribution')
        .set(bearer(u.accessToken))
        .expect(403);
    });
  });

  describe('GET /admin/users/:id/detail', () => {
    it('상세도 목록과 같은 판정 결과를 준다', async () => {
      const admin = await signInAsAdmin(app);
      const u = await signInAsUser(app, { nickname: 'plat-detail' });
      await seedSession(u.user.id, APP_UA);
      await seedSession(u.user.id, WEB_UA);

      const res = await request(app.getHttpServer())
        .get(`/admin/users/${u.user.id}/detail`)
        .set(bearer(admin.accessToken))
        .expect(200);

      expect(res.body.data.platform).toMatchObject({ app: true, web: true });
    });
  });
});
