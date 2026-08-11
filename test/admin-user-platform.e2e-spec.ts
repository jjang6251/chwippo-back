/**
 * 회원 사용 환경(웹/앱) e2e — **N+1 방지가 이 spec 의 존재 이유다.**
 *
 * 🔴 판정 근거가 **UA → 로그인 스탬프**로 교체됐다 (2026-08-04). 직전 구현은 앱 사용자를
 * 하나도 못 잡았다 — 네이티브 SDK 로그인은 WebView 를 안 거쳐 UA 에 앱 표식이 없다.
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
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsAdmin, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

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

  /**
   * 로그인 스탬프를 직접 심는다 — 실제 카카오/Apple 왕복은 e2e 에서 불가능하다.
   * (스탬프가 **실제로 찍히는지**는 `auth.controller` 의 인자 전달로 보장되고,
   *  여기서는 그 값이 **화면 판정으로 이어지는지**를 본다.)
   */
  async function seedLogin(userId: string, platform: 'app' | 'web') {
    const col =
      platform === 'app' ? 'first_app_login_at' : 'first_web_login_at';
    await ds.query(`UPDATE users SET ${col} = now() WHERE id = $1`, [userId]);
  }

  /**
   * SQL 실행 횟수를 센다.
   *
   * 🔴 `DataSource.query` 만 감시하면 **QueryBuilder 로 나가는 쿼리를 통째로 놓친다** —
   * 둘 다 결국 `QueryRunner.query` 를 거치므로 **프로토타입**에 스파이를 건다.
   */
  async function countQueries<T>(
    fn: () => Promise<T>,
  ): Promise<[T, number, string[]]> {
    const runner = ds.createQueryRunner();
    const proto = Object.getPrototypeOf(runner) as {
      query: (...a: never[]) => unknown;
    };
    await runner.release();

    const spy = jest.spyOn(proto, 'query');
    try {
      const out = await fn();
      const sqls = spy.mock.calls.map((c) => String(c[0]));
      return [out, spy.mock.calls.length, sqls];
    } finally {
      spy.mockRestore();
    }
  }

  /**
   * 🔴 **여러 번 재고 최소값을 취한다.**
   *
   * 스파이가 프로토타입에 걸려 있어 **프로세스 전체 쿼리**를 센다 — 측정 대상과 무관한
   * 비동기 작업의 잔류 쿼리(await 하지 않고 발사되는 best-effort audit insert 류)가
   * 느린 러너에서 측정 창 안에 늦게 착지하면 카운트가 부푼다.
   * CI #435 실사고: `q1=6 > q5=4` — **N+1 이면 사용자가 많은 쪽이 적을 수 없다.** 측정 오염이다.
   *
   * 노이즈는 카운트를 **더하기만 하고 빼지는 못하므로 최소값이 참값**이다.
   * 잔류 promise 는 유한개라 첫 샘플이 소진시킨다 — 재발하려면 3회 연속 오염돼야 한다.
   */
  async function measureQueriesStable(
    fn: () => Promise<unknown>,
    samples = 3,
  ): Promise<{ count: number; sqls: string[] }> {
    const [, count, sqls] = await countQueries(fn);
    let best = { count, sqls };
    for (let i = 1; i < samples; i += 1) {
      const [, c, s] = await countQueries(fn);
      if (c < best.count) best = { count: c, sqls: s };
    }
    return best;
  }

  describe('GET /admin/users — 목록 뱃지', () => {
    it('사용 환경이 사용자마다 붙는다 (앱 / 웹 / 둘 다 / 없음)', async () => {
      const admin = await signInAsAdmin(app);
      const u1 = await signInAsUser(app, { nickname: 'plat-app' });
      const u2 = await signInAsUser(app, { nickname: 'plat-web' });
      const u3 = await signInAsUser(app, { nickname: 'plat-both' });

      await seedLogin(u1.user.id, 'app');
      await seedLogin(u2.user.id, 'web');
      await seedLogin(u3.user.id, 'app');
      await seedLogin(u3.user.id, 'web');

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
      await seedLogin(one.user.id, 'web');

      // ⚠️ 첫 요청은 인증 경로 워밍업으로 쿼리가 더 나간다 — 측정 전에 한 번 태워 편차를 없앤다
      await request(app.getHttpServer())
        .get('/admin/users?limit=100')
        .set(bearer(admin.accessToken))
        .expect(200);

      const m1 = await measureQueriesStable(async () => {
        await request(app.getHttpServer())
          .get('/admin/users?limit=100')
          .set(bearer(admin.accessToken))
          .expect(200);
      });

      for (let i = 2; i <= 5; i += 1) {
        const u = await signInAsUser(app, { nickname: `nplus-${i}` });
        await seedLogin(u.user.id, i % 2 === 0 ? 'app' : 'web');
      }

      const m5 = await measureQueriesStable(async () => {
        await request(app.getHttpServer())
          .get('/admin/users?limit=100')
          .set(bearer(admin.accessToken))
          .expect(200);
      });

      // 실패하면 **어떤 쿼리가 침입했는지**가 그대로 찍혀야 다음 조사에서 헤매지 않는다
      if (m5.count !== m1.count) {
        throw new Error(
          [
            `쿼리 수 불일치 — 1명: ${m1.count} vs 5명: ${m5.count}`,
            '(최소값 3회 측정 후에도 다르면 진짜 회귀이거나 지속적 백그라운드 쿼리다)',
            '--- 1명 측정에 잡힌 SQL ---',
            ...m1.sqls,
            '--- 5명 측정에 잡힌 SQL ---',
            ...m5.sqls,
          ].join('\n'),
        );
      }
    });

    /**
     * 🔴 **경화 자체의 회귀 가드다.** 첫 샘플에만 노이즈를 심으므로
     * `measureQueriesStable` 을 단일 측정으로 되돌리면 이 spec 이 즉시 실패한다.
     */
    it('🔴 잔류 쿼리가 측정 창에 착지해도 최소값 측정은 오염되지 않는다 (CI #435 재현)', async () => {
      let first = true;
      const measured = async () => {
        if (first) {
          first = false;
          // best-effort audit insert 의 모형 — await 없이 발사돼 측정 창 안에 착지한다
          void ds.query('SELECT 1');
          await new Promise((r) => setTimeout(r, 20));
        }
        await ds.query('SELECT 2');
      };
      const m = await measureQueriesStable(measured);
      expect(m.count).toBe(1); // 1번째 샘플은 2로 오염되지만 2·3번째가 참값 1을 돌려준다
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

      await seedLogin(a.user.id, 'app');
      await seedLogin(w.user.id, 'web');
      await seedLogin(b.user.id, 'app');
      await seedLogin(b.user.id, 'web');

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
      await seedLogin(u.user.id, 'app');
      await seedLogin(u.user.id, 'web');

      const res = await request(app.getHttpServer())
        .get(`/admin/users/${u.user.id}/detail`)
        .set(bearer(admin.accessToken))
        .expect(200);

      expect(res.body.data.platform).toMatchObject({ app: true, web: true });
    });
  });
});
