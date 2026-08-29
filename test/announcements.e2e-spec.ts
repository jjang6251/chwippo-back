/**
 * Announcements e2e (LRR P2T3 PR Y).
 *
 * public active + admin CRUD — RolesGuard·audit + 정보 누수 차단.
 * (starts/ends 논리 검증은 announcements-starts-ends.e2e-spec.ts 별도)
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { Announcement } from '../src/announcements/announcement.entity';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsAdmin, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('Announcements (e2e, PR Y)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await cleanAllTestUsers(app);
    await app.close();
  });

  afterEach(async () => {
    // announcement는 user FK 없어 cleanAllTestUsers로 안 사라짐 — 명시 정리
    await app
      .get(DataSource)
      .getRepository(Announcement)
      .createQueryBuilder()
      .delete()
      .execute();
    await cleanAllTestUsers(app);
  });

  describe('GET /announcements/active (public)', () => {
    it('미인증 허용 → 200', async () => {
      await request(app.getHttpServer())
        .get('/announcements/active')
        .expect(200);
    });

    it('active 공지 없음 → 200 + data 빈 배열', async () => {
      const res = await request(app.getHttpServer())
        .get('/announcements/active')
        .expect(200);
      // ResponseTransformInterceptor wrap. data 는 항상 배열
      expect(res.body.data).toEqual([]);
    });

    it('active=true·기간 내 공지 → 200 + 해당 공지 1개', async () => {
      const { accessToken } = await signInAsAdmin(app);
      const created = await request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({
          title: '활성 공지',
          body: '본문',
          type: 'banner',
          active: true,
        })
        .expect(201);

      const active = await request(app.getHttpServer())
        .get('/announcements/active')
        .expect(200);
      expect(active.body.data).toHaveLength(1);
      expect(active.body.data[0].id).toBe(created.body.data.id);
    });

    it('active=false 공지 → 미노출', async () => {
      const { accessToken } = await signInAsAdmin(app);
      await request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({
          title: '비활성',
          body: '본문',
          type: 'banner',
          active: false,
        })
        .expect(201);

      const active = await request(app.getHttpServer())
        .get('/announcements/active')
        .expect(200);
      expect(active.body.data).toEqual([]);
    });

    it('모달·배너 동시 활성 → 2개, 모달이 먼저', async () => {
      const { accessToken } = await signInAsAdmin(app);
      const banner = await request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({
          title: '점검 배너',
          body: '본문',
          type: 'banner',
          active: true,
        })
        .expect(201);
      const modal = await request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({
          title: '새 기능 모달',
          body: '본문',
          type: 'modal',
          kind: 'feature',
          active: true,
        })
        .expect(201);

      const active = await request(app.getHttpServer())
        .get('/announcements/active')
        .expect(200);
      expect(active.body.data.map((a: { id: string }) => a.id)).toEqual([
        modal.body.data.id,
        banner.body.data.id,
      ]);
    });

    it('같은 type 이 여러 개면 최신 1개만 (type 당 1개 상한)', async () => {
      const { accessToken } = await signInAsAdmin(app);
      await request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({ title: '옛 배너', body: '본문', type: 'banner', active: true })
        .expect(201);
      const newer = await request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({ title: '새 배너', body: '본문', type: 'banner', active: true })
        .expect(201);

      const active = await request(app.getHttpServer())
        .get('/announcements/active')
        .expect(200);
      expect(active.body.data).toHaveLength(1);
      expect(active.body.data[0].id).toBe(newer.body.data.id);
    });
  });

  describe('kind · CTA', () => {
    const base = {
      title: '새 기능 안내',
      body: '본문',
      type: 'modal' as const,
      active: true,
    };

    /** 공지 1건 생성 — 기대 status 를 넘겨 실패 케이스도 같은 헬퍼로 쓴다 */
    const post = async (body: Record<string, unknown>, status = 201) => {
      const { accessToken } = await signInAsAdmin(app);
      return request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send(body)
        .expect(status);
    };

    it("kind 생략 → 201 + 'notice' 기본값", async () => {
      const created = await post(base);
      expect(created.body.data.kind).toBe('notice');
      expect(created.body.data.cta_label).toBeNull();
      expect(created.body.data.cta_path).toBeNull();
    });

    it.each(['feature', 'improvement', 'fix', 'notice'])(
      'kind=%s → 201 + 그대로 저장',
      async (kind) => {
        const created = await post({ ...base, kind });
        expect(created.body.data.kind).toBe(kind);
      },
    );

    it('kind 정의 밖 값 → 400', async () => {
      await post({ ...base, kind: 'urgent' }, 400);
    });

    it('CTA 라벨+내부 경로 → 201, active 응답에도 실려 나온다', async () => {
      const created = await post({
        ...base,
        kind: 'feature',
        cta_label: '지금 해보기',
        cta_path: '/board?add=posting',
      });
      expect(created.body.data.cta_label).toBe('지금 해보기');
      expect(created.body.data.cta_path).toBe('/board?add=posting');

      const active = await request(app.getHttpServer())
        .get('/announcements/active')
        .expect(200);
      expect(active.body.data[0]).toMatchObject({
        id: created.body.data.id,
        kind: 'feature',
        cta_label: '지금 해보기',
        cta_path: '/board?add=posting',
      });
    });

    it.each([
      ['https://evil.com', '외부 URL'],
      ['//evil.com', '프로토콜 상대 URL'],
      ['board?add=posting', '슬래시 없이 시작'],
      ['/board 추가', '공백 포함'],
    ])('cta_path=%s → 400 (%s)', async (cta_path) => {
      const res = await post(
        {
          ...base,
          cta_label: '지금 해보기',
          cta_path,
        },
        400,
      );
      expect(res.body.message).toContain('앱 내부 경로');
    });

    it('CTA 라벨만 → 400', async () => {
      const res = await post({ ...base, cta_label: '지금 해보기' }, 400);
      expect(res.body.message).toContain('함께');
    });

    it('CTA 경로만 → 400', async () => {
      const res = await post({ ...base, cta_path: '/board' }, 400);
      expect(res.body.message).toContain('함께');
    });

    it('cta_label 31자 → 400 / 30자 → 201 (경계값)', async () => {
      await post(
        {
          ...base,
          cta_label: 'ㄱ'.repeat(31),
          cta_path: '/board',
        },
        400,
      );

      await post({
        ...base,
        cta_label: 'ㄱ'.repeat(30),
        cta_path: '/board',
      });
    });

    it('cta_label 앞뒤 공백은 trim 후 검증·저장한다', async () => {
      const created = await post({
        ...base,
        cta_label: '  지금 해보기  ',
        cta_path: '  /board  ',
      });
      expect(created.body.data.cta_label).toBe('지금 해보기');
      expect(created.body.data.cta_path).toBe('/board');
    });

    it('PATCH 로 CTA 둘 다 null → 200 + 비워짐', async () => {
      const { accessToken } = await signInAsAdmin(app);
      const created = await post({
        ...base,
        cta_label: '지금 해보기',
        cta_path: '/board',
      });

      const patched = await request(app.getHttpServer())
        .patch(`/admin/announcements/${created.body.data.id}`)
        .set(bearer(accessToken))
        .send({ cta_label: null, cta_path: null })
        .expect(200);
      expect(patched.body.data.cta_label).toBeNull();
      expect(patched.body.data.cta_path).toBeNull();
    });

    it('PATCH 로 한쪽만 null → 400 (경로 고아 방지)', async () => {
      const { accessToken } = await signInAsAdmin(app);
      const created = await post({
        ...base,
        cta_label: '지금 해보기',
        cta_path: '/board',
      });

      await request(app.getHttpServer())
        .patch(`/admin/announcements/${created.body.data.id}`)
        .set(bearer(accessToken))
        .send({ cta_label: null })
        .expect(400);
    });

    it('PATCH 로 kind·CTA 를 함께 교체 → 200', async () => {
      const { accessToken } = await signInAsAdmin(app);
      const created = await post(base);

      const patched = await request(app.getHttpServer())
        .patch(`/admin/announcements/${created.body.data.id}`)
        .set(bearer(accessToken))
        .send({
          kind: 'improvement',
          cta_label: '확인하러 가기',
          cta_path: '/calendar',
        })
        .expect(200);
      expect(patched.body.data).toMatchObject({
        kind: 'improvement',
        cta_label: '확인하러 가기',
        cta_path: '/calendar',
      });
    });

    it('admin 목록에도 새 필드가 나온다', async () => {
      const { accessToken } = await signInAsAdmin(app);
      await post({
        ...base,
        kind: 'fix',
        cta_label: '지금 해보기',
        cta_path: '/board',
      });

      const list = await request(app.getHttpServer())
        .get('/admin/announcements')
        .set(bearer(accessToken))
        .expect(200);
      expect(list.body.data[0]).toMatchObject({
        kind: 'fix',
        cta_label: '지금 해보기',
        cta_path: '/board',
      });
    });
  });

  describe('admin CRUD (RolesGuard)', () => {
    it('POST role=user → 403', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({
          title: 'x',
          body: 'x',
          type: 'banner',
          active: true,
        })
        .expect(403);
    });

    it('GET admin 목록 admin → 200 / user → 403', async () => {
      const { accessToken: adminToken } = await signInAsAdmin(app);
      await request(app.getHttpServer())
        .get('/admin/announcements')
        .set(bearer(adminToken))
        .expect(200);

      const { accessToken: userToken } = await signInAsUser(app);
      await request(app.getHttpServer())
        .get('/admin/announcements')
        .set(bearer(userToken))
        .expect(403);
    });

    it('PATCH 정상 + DELETE → 204', async () => {
      const { accessToken } = await signInAsAdmin(app);
      const created = await request(app.getHttpServer())
        .post('/admin/announcements')
        .set(bearer(accessToken))
        .send({ title: '수정 대상', body: '본문', type: 'modal', active: true })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .patch(`/admin/announcements/${id}`)
        .set(bearer(accessToken))
        .send({ title: '수정됨' })
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/admin/announcements/${id}`)
        .set(bearer(accessToken))
        .expect(204);
    });

    it('PATCH/DELETE 미인증 → 401', async () => {
      await request(app.getHttpServer())
        .patch('/admin/announcements/00000000-0000-0000-0000-000000000000')
        .send({ title: 'x' })
        .expect(401);
      await request(app.getHttpServer())
        .delete('/admin/announcements/00000000-0000-0000-0000-000000000000')
        .expect(401);
    });
  });
});
