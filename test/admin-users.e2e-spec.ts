/**
 * Admin user 관리 e2e (LRR P2T1 PR R H-10·H-11·H-12).
 *
 * PATCH/DELETE/warn/export — RolesGuard·self-protection·audit·NotFound 검증.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { User } from '../src/users/user.entity';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsAdmin, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('Admin user management (e2e, H-10·H-11·H-12)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await cleanAllTestUsers(app);
    await app.close();
  });

  afterEach(async () => {
    await cleanAllTestUsers(app);
  });

  // ── PATCH /admin/users/:id (H-10) ─────────────────────
  describe('PATCH /admin/users/:id', () => {
    it('정상 nickname 변경 → 200', async () => {
      const { user: target } = await signInAsUser(app, { nickname: 'old' });
      const { accessToken: adminToken } = await signInAsAdmin(app);

      await request(app.getHttpServer())
        .patch(`/admin/users/${target.id}`)
        .set(bearer(adminToken))
        .send({ nickname: '새닉네임' })
        .expect(200);

      const updated = await app
        .get(DataSource)
        .getRepository(User)
        .findOneBy({ id: target.id });
      expect(updated?.nickname).toBe('새닉네임');
    });

    it('정상 suspend (suspendedAt 설정)', async () => {
      const { user: target } = await signInAsUser(app);
      const { accessToken: adminToken } = await signInAsAdmin(app);

      await request(app.getHttpServer())
        .patch(`/admin/users/${target.id}`)
        .set(bearer(adminToken))
        .send({ suspended: true })
        .expect(200);

      const updated = await app
        .get(DataSource)
        .getRepository(User)
        .findOneBy({ id: target.id });
      expect(updated?.suspendedAt).not.toBeNull();
    });

    it('정상 unsuspend', async () => {
      const { user: target } = await signInAsUser(app, { suspended: true });
      const { accessToken: adminToken } = await signInAsAdmin(app);

      await request(app.getHttpServer())
        .patch(`/admin/users/${target.id}`)
        .set(bearer(adminToken))
        .send({ suspended: false })
        .expect(200);

      const updated = await app
        .get(DataSource)
        .getRepository(User)
        .findOneBy({ id: target.id });
      expect(updated?.suspendedAt).toBeNull();
    });

    it('정상 role 승격 (user → admin)', async () => {
      const { user: target } = await signInAsUser(app);
      const { accessToken: adminToken } = await signInAsAdmin(app);

      await request(app.getHttpServer())
        .patch(`/admin/users/${target.id}`)
        .set(bearer(adminToken))
        .send({ role: 'admin' })
        .expect(200);

      const updated = await app
        .get(DataSource)
        .getRepository(User)
        .findOneBy({ id: target.id });
      expect(updated?.role).toBe('admin');
    });

    it('본인 self-suspend → 403 (ForbiddenException)', async () => {
      const { user: admin, accessToken: adminToken } = await signInAsAdmin(app);
      return request(app.getHttpServer())
        .patch(`/admin/users/${admin.id}`)
        .set(bearer(adminToken))
        .send({ suspended: true })
        .expect(403);
    });

    it('본인 self-role 변경 → 403', async () => {
      const { user: admin, accessToken: adminToken } = await signInAsAdmin(app);
      return request(app.getHttpServer())
        .patch(`/admin/users/${admin.id}`)
        .set(bearer(adminToken))
        .send({ role: 'user' })
        .expect(403);
    });

    it('본인 self-rename → 200 (셀프 닉네임 변경 허용)', async () => {
      const { user: admin, accessToken: adminToken } = await signInAsAdmin(app);
      return request(app.getHttpServer())
        .patch(`/admin/users/${admin.id}`)
        .set(bearer(adminToken))
        .send({ nickname: '관리자새닉' })
        .expect(200);
    });

    it('존재 안 함 → 404', async () => {
      const { accessToken: adminToken } = await signInAsAdmin(app);
      return request(app.getHttpServer())
        .patch('/admin/users/00000000-0000-0000-0000-000000000000')
        .set(bearer(adminToken))
        .send({ nickname: 'x' })
        .expect(404);
    });

    it('role=user → 403 (RolesGuard)', async () => {
      const { user: target } = await signInAsUser(app);
      const { accessToken: userToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .patch(`/admin/users/${target.id}`)
        .set(bearer(userToken))
        .send({ nickname: 'x' })
        .expect(403);
    });

    it('미인증 → 401', async () => {
      const { user: target } = await signInAsUser(app);
      return request(app.getHttpServer())
        .patch(`/admin/users/${target.id}`)
        .send({ nickname: 'x' })
        .expect(401);
    });
  });

  // ── DELETE /admin/users/:id (H-11) ────────────────────
  describe('DELETE /admin/users/:id', () => {
    it('정상 → 204 + DB row 삭제', async () => {
      const { user: target } = await signInAsUser(app);
      const { accessToken: adminToken } = await signInAsAdmin(app);
      const userRepo = app.get(DataSource).getRepository(User);

      await request(app.getHttpServer())
        .delete(`/admin/users/${target.id}`)
        .set(bearer(adminToken))
        .expect(204);

      expect(await userRepo.findOneBy({ id: target.id })).toBeNull();
    });

    it('본인 self-delete → 403', async () => {
      const { user: admin, accessToken: adminToken } = await signInAsAdmin(app);
      return request(app.getHttpServer())
        .delete(`/admin/users/${admin.id}`)
        .set(bearer(adminToken))
        .expect(403);
    });

    it('존재 안 함 → 404', async () => {
      const { accessToken: adminToken } = await signInAsAdmin(app);
      return request(app.getHttpServer())
        .delete('/admin/users/00000000-0000-0000-0000-000000000000')
        .set(bearer(adminToken))
        .expect(404);
    });

    it('role=user → 403', async () => {
      const { user: target } = await signInAsUser(app);
      const { accessToken: userToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .delete(`/admin/users/${target.id}`)
        .set(bearer(userToken))
        .expect(403);
    });
  });

  // ── POST /admin/users/:id/warn (H-12) ─────────────────
  describe('POST /admin/users/:id/warn', () => {
    it('정상 message → 201 + audit warn', async () => {
      const { user: target } = await signInAsUser(app);
      const { accessToken: adminToken } = await signInAsAdmin(app);

      await request(app.getHttpServer())
        .post(`/admin/users/${target.id}/warn`)
        .set(bearer(adminToken))
        .send({ message: '주의 부탁드립니다.' })
        .expect(201);
    });

    it('빈 message → 400 (MinLength 1·IsNotEmpty)', async () => {
      const { user: target } = await signInAsUser(app);
      const { accessToken: adminToken } = await signInAsAdmin(app);
      return request(app.getHttpServer())
        .post(`/admin/users/${target.id}/warn`)
        .set(bearer(adminToken))
        .send({ message: '' })
        .expect(400);
    });

    it('501자 message → 400 (MaxLength 500)', async () => {
      const { user: target } = await signInAsUser(app);
      const { accessToken: adminToken } = await signInAsAdmin(app);
      return request(app.getHttpServer())
        .post(`/admin/users/${target.id}/warn`)
        .set(bearer(adminToken))
        .send({ message: 'a'.repeat(501) })
        .expect(400);
    });

    it('role=user → 403', async () => {
      const { user: target } = await signInAsUser(app);
      const { accessToken: userToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .post(`/admin/users/${target.id}/warn`)
        .set(bearer(userToken))
        .send({ message: 'x' })
        .expect(403);
    });
  });

  // ── POST /admin/users/:id/export (H-12) ───────────────
  describe('POST /admin/users/:id/export', () => {
    it('정상 → 201 + user 데이터 + refreshToken·kakaoId 미포함', async () => {
      const { user: target } = await signInAsUser(app);
      const { accessToken: adminToken } = await signInAsAdmin(app);

      const res = await request(app.getHttpServer())
        .post(`/admin/users/${target.id}/export`)
        .set(bearer(adminToken))
        .expect(201);

      // user 정보 + 자식 데이터 포함, 민감 필드 제외
      expect(res.body.data).not.toHaveProperty('refreshToken');
      expect(res.body.data).not.toHaveProperty('kakaoId');
      // user 키 자체엔 refreshToken·kakaoId 미포함 (재귀 검증 필요 시 별도)
      const userData = res.body.data.user;
      expect(userData).not.toHaveProperty('refreshToken');
      expect(userData).not.toHaveProperty('kakaoId');
    });

    it('role=user → 403', async () => {
      const { user: target } = await signInAsUser(app);
      const { accessToken: userToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .post(`/admin/users/${target.id}/export`)
        .set(bearer(userToken))
        .expect(403);
    });
  });

  /**
   * GET /admin/users/:id/detail — 지원 카드 목록.
   *
   * 현재 스텝을 LATERAL + OFFSET current_step_index 로 뽑는 SQL 이라
   * **mock 유닛 spec 으로는 검증 불가** — 실 DB e2e 로만 판정된다.
   *
   * 시나리오:
   *  1. 카드 0개 → 빈 배열 (에러 아님)
   *  2. 카드 있음 → 회사·직무·상태 + 현재 스텝명·예정일
   *  3. current_step_index 가 0 이 아닐 때 그 번째 스텝을 집는다 (OFFSET 검증)
   *  4. 스텝 0개 카드 → currentStep* 는 null (LEFT JOIN 이라 카드 자체는 나옴)
   *  5. soft delete 카드는 제외
   *  6. **사용자 작성 본문(메모)은 응답에 없다** — 운영 조회용 최소 필드
   *  7. role=user → 403
   */
  describe('GET /admin/users/:id/detail — 지원 카드', () => {
    async function seedApplication(
      userId: string,
      over: {
        company?: string;
        stepIndex?: number;
        steps?: { name: string; date: string | null }[];
        deleted?: boolean;
        memo?: string;
      } = {},
    ): Promise<string> {
      const ds = app.get(DataSource);
      const [row] = await ds.query<Array<{ id: string }>>(
        `INSERT INTO applications
           (user_id, company_name, job_title, status, current_step_index, memo, deleted_at)
         VALUES ($1, $2, '백엔드 개발자', 'IN_PROGRESS', $3, $4, $5)
         RETURNING id`,
        [
          userId,
          over.company ?? '테스트회사',
          over.stepIndex ?? 0,
          over.memo ?? null,
          over.deleted ? new Date() : null,
        ],
      );
      const steps = over.steps ?? [];
      for (const [i, s] of steps.entries()) {
        await ds.query(
          `INSERT INTO application_steps (application_id, order_index, name, scheduled_date)
           VALUES ($1, $2, $3, $4)`,
          [row.id, i, s.name, s.date],
        );
      }
      return row.id;
    }

    const detail = (token: string, id: string) =>
      request(app.getHttpServer())
        .get(`/admin/users/${id}/detail`)
        .set(bearer(token))
        .expect(200);

    it('1. 카드 0개 → 빈 배열', async () => {
      const { user: target } = await signInAsUser(app);
      const { accessToken } = await signInAsAdmin(app);
      const res = await detail(accessToken, target.id);
      expect(res.body.data.applications).toEqual([]);
      expect(res.body.data.activityStats.applicationCount).toBe(0);
    });

    it('2·6. 회사·직무·상태·현재 스텝을 주고, 사용자 메모는 주지 않는다', async () => {
      const { user: target } = await signInAsUser(app);
      await seedApplication(target.id, {
        company: '카카오',
        memo: '여기 꼭 붙고 싶다 — 사용자 작성 본문',
        steps: [{ name: '서류', date: '2026-08-10T09:00:00Z' }],
      });
      const { accessToken } = await signInAsAdmin(app);
      const res = await detail(accessToken, target.id);

      const [card] = res.body.data.applications;
      expect(card.companyName).toBe('카카오');
      expect(card.jobTitle).toBe('백엔드 개발자');
      expect(card.status).toBe('IN_PROGRESS');
      expect(card.currentStepName).toBe('서류');
      expect(card.currentStepDate).toBeTruthy();
      // 운영 조회용 최소 필드 — 사용자가 쓴 본문은 export 경로로만
      expect(card).not.toHaveProperty('memo');
      expect(JSON.stringify(res.body.data.applications)).not.toContain(
        '꼭 붙고 싶다',
      );
    });

    it('3. current_step_index 가 1 이면 두 번째 스텝을 집는다 (OFFSET)', async () => {
      const { user: target } = await signInAsUser(app);
      await seedApplication(target.id, {
        stepIndex: 1,
        steps: [
          { name: '서류', date: null },
          { name: '1차 면접', date: '2026-09-01T02:00:00Z' },
          { name: '2차 면접', date: null },
        ],
      });
      const { accessToken } = await signInAsAdmin(app);
      const res = await detail(accessToken, target.id);
      expect(res.body.data.applications[0].currentStepName).toBe('1차 면접');
    });

    it('4. 스텝 0개 카드도 목록에 나오고 currentStep 은 null', async () => {
      const { user: target } = await signInAsUser(app);
      await seedApplication(target.id, { company: '스텝없음', steps: [] });
      const { accessToken } = await signInAsAdmin(app);
      const res = await detail(accessToken, target.id);
      expect(res.body.data.applications).toHaveLength(1);
      expect(res.body.data.applications[0].currentStepName).toBeNull();
      expect(res.body.data.applications[0].currentStepDate).toBeNull();
    });

    it('5. soft delete 카드는 제외', async () => {
      const { user: target } = await signInAsUser(app);
      await seedApplication(target.id, { company: '살아있음' });
      await seedApplication(target.id, { company: '삭제됨', deleted: true });
      const { accessToken } = await signInAsAdmin(app);
      const res = await detail(accessToken, target.id);
      expect(res.body.data.applications).toHaveLength(1);
      expect(res.body.data.applications[0].companyName).toBe('살아있음');
    });

    /**
     * 방문일수 (visitStats) — `user_daily_visits` 집계.
     *
     * "최근 30일" 판정이 **KST 날짜 산술**이라 mock 유닛 spec 으로는 검증 불가하다.
     * 실 DB 에서 `(NOW() AT TIME ZONE 'Asia/Seoul')::date` 와 비교돼야 의미가 있다.
     *
     * 시나리오:
     *  8.  방문 0건 → 0·0·null (에러 아님)
     *  9.  🔴 경계 — today-29 는 최근 30일에 포함, today-30 은 제외
     *  10. firstVisitDate = 가장 오래된 방문일 (가입일 아님 — 집계 시작 이전 가입자 오해 방지)
     *  11. 다른 사용자 방문은 섞이지 않는다
     */
    async function seedVisits(userId: string, daysAgoList: number[]) {
      const ds = app.get(DataSource);
      for (const d of daysAgoList) {
        await ds.query(
          `INSERT INTO user_daily_visits (user_id, visit_date)
           VALUES ($1, (NOW() AT TIME ZONE 'Asia/Seoul')::date - $2::int)
           ON CONFLICT DO NOTHING`,
          [userId, d],
        );
      }
    }

    it('8. 방문 기록 0건 → 0·0·null', async () => {
      const { user: target } = await signInAsUser(app);
      const { accessToken } = await signInAsAdmin(app);
      const res = await detail(accessToken, target.id);
      // 로그인(토큰 발급)만으로는 방문이 안 남는다 — JwtStrategy 를 타는 인증 요청이 있어야 기록된다.
      // 즉 "가입만 하고 안 들어온 사용자" 상태이고, 이때 firstVisitDate 는 null 이어야 한다
      // (0 이나 '' 로 뭉개면 프론트가 "1970-01-01 부터 집계" 로 그린다)
      expect(res.body.data.visitStats).toEqual({
        totalDays: 0,
        last30Days: 0,
        firstVisitDate: null,
      });
    });

    it('9. 🔴 경계 — today-29 는 최근 30일 포함, today-30 은 제외', async () => {
      const { user: target } = await signInAsUser(app);
      const ds = app.get(DataSource);
      // 로그인이 남긴 오늘 방문을 지우고 경계 2건만 남긴다
      await ds.query(`DELETE FROM user_daily_visits WHERE user_id = $1`, [
        target.id,
      ]);
      await seedVisits(target.id, [29, 30]);

      const { accessToken } = await signInAsAdmin(app);
      const res = await detail(accessToken, target.id);

      expect(res.body.data.visitStats.totalDays).toBe(2);
      expect(res.body.data.visitStats.last30Days).toBe(1); // 29 만 포함
    });

    it('10. firstVisitDate = 가장 오래된 방문일 (가입일 아님)', async () => {
      const { user: target } = await signInAsUser(app);
      const ds = app.get(DataSource);
      await ds.query(`DELETE FROM user_daily_visits WHERE user_id = $1`, [
        target.id,
      ]);
      await seedVisits(target.id, [100, 3]);

      const { accessToken } = await signInAsAdmin(app);
      const res = await detail(accessToken, target.id);

      const [expected] = await ds.query<Array<{ d: string }>>(
        `SELECT ((NOW() AT TIME ZONE 'Asia/Seoul')::date - 100)::text AS d`,
      );
      expect(res.body.data.visitStats.firstVisitDate).toBe(expected.d);
      expect(res.body.data.visitStats.totalDays).toBe(2);
      expect(res.body.data.visitStats.last30Days).toBe(1); // 3 만
    });

    it('11. 다른 사용자 방문은 섞이지 않는다', async () => {
      const { user: target } = await signInAsUser(app);
      const { user: other } = await signInAsUser(app);
      const ds = app.get(DataSource);
      await ds.query(`DELETE FROM user_daily_visits WHERE user_id = ANY($1)`, [
        [target.id, other.id],
      ]);
      await seedVisits(target.id, [1]);
      await seedVisits(other.id, [1, 2, 3]);

      const { accessToken } = await signInAsAdmin(app);
      const res = await detail(accessToken, target.id);

      expect(res.body.data.visitStats.totalDays).toBe(1);
    });

    it('7. role=user → 403', async () => {
      const { user: target } = await signInAsUser(app);
      const { accessToken: userToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .get(`/admin/users/${target.id}/detail`)
        .set(bearer(userToken))
        .expect(403);
    });
  });

  /**
   * 권한 가드 전수 스윕 — `/admin/users` **모든** 라우트가 미인증 401 · 일반 user 403 인지.
   *
   * 개별 테스트가 일부 라우트만 덮고 있어, 새 라우트를 추가하면서 클래스 레벨
   * `@UseGuards(RolesGuard) @Roles('admin')` 밖에 두는 실수를 잡지 못했다.
   * 이 목록은 컨트롤러의 라우트와 1:1 이어야 하며, 라우트를 추가하면 여기도 추가한다
   * (아래 "라우트 수 일치" 테스트가 누락을 강제한다).
   */
  describe('권한 가드 전수 스윕 (OWASP API1/API5 · CWE-285)', () => {
    const ROUTES: [string, string][] = [
      ['get', ''],
      ['get', '/:id'],
      ['patch', '/:id'],
      ['delete', '/:id'],
      ['post', '/:id/warn'],
      ['post', '/:id/export'],
      ['post', '/:id/coins/grant'],
      ['post', '/:id/coins/revoke'],
      ['patch', '/:id/suspend'],
      ['delete', '/:id/suspend'],
      ['get', '/:id/detail'],
      ['patch', '/:id/tier'],
    ];

    /** GET/DELETE 에 body 를 붙이면 ECONNRESET — 쓰기 메서드에만 payload */
    async function call(method: string, path: string, token?: string) {
      const req = request(app.getHttpServer())[
        method as 'get' | 'post' | 'patch' | 'delete'
      ](`/admin/users${path}`);
      if (token) req.set(bearer(token));
      if (method === 'post' || method === 'patch') req.send({});
      return req;
    }

    /** 순차 실행 — 동일 app 인스턴스에 12개를 동시에 쏘면 커넥션이 끊긴다 */
    async function sweep(token: string | undefined, id: string) {
      const out: string[] = [];
      for (const [m, p] of ROUTES) {
        const res = await call(m, p.replace(':id', id), token);
        out.push(`${m.toUpperCase()} ${p} → ${res.status}`);
      }
      return out;
    }

    it('미인증 → 전 라우트 401 (인증 우회 0)', async () => {
      const results = await sweep(undefined, 'some-id');
      // 401 이 아닌 라우트가 있으면 어떤 라우트인지 실패 메시지에 그대로 보인다
      expect(results.filter((r) => !r.endsWith('→ 401'))).toEqual([]);
    });

    it('일반 user 토큰 → 전 라우트 403 (권한 상승 0)', async () => {
      const { user: target } = await signInAsUser(app);
      const { accessToken: userToken } = await signInAsUser(app);
      const results = await sweep(userToken, target.id);
      expect(results.filter((r) => !r.endsWith('→ 403'))).toEqual([]);
    });

    it('라우트 수 일치 — 컨트롤러에 라우트를 추가하면 이 스윕도 갱신해야 한다', () => {
      const src = readFileSync(
        join(__dirname, '../src/admin/admin-users.controller.ts'),
        'utf-8',
      );
      const declared = (src.match(/@(Get|Post|Patch|Delete)\(/g) ?? []).length;
      expect(ROUTES).toHaveLength(declared);
    });
  });
});
