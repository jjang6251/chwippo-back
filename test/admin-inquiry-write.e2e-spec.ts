/**
 * Admin inquiry 댓글·close e2e (LRR P2T1 PR R H-8·H-9 + AD6-6 회귀).
 *
 * RolesGuard·audit·status 전환·CLOSED 차단 패턴 (LRR Tier 3 PR H 회귀) 모두 검증.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { Inquiry } from '../src/inquiries/inquiry.entity';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsAdmin, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('Admin inquiry write (e2e, H-8·H-9·AD6-6)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await cleanAllTestUsers(app);
    await app.close();
  });

  afterEach(async () => {
    // inquiry는 user cascade FK로 삭제됨
    await cleanAllTestUsers(app);
  });

  async function seedInquiry(userId: string): Promise<Inquiry> {
    const dataSource = app.get(DataSource);
    const repo = dataSource.getRepository(Inquiry);
    const inquiry = repo.create({
      user_id: userId,
      category: '버그 신고',
      title: 'e2e 테스트 문의',
      content: 'e2e 테스트 본문 내용입니다.',
      status: 'OPEN',
      user_unread: 0,
      admin_unread: 1,
    });
    return repo.save(inquiry);
  }

  // ── POST /admin/inquiries/:id/comments (H-8) ──────────
  describe('POST /admin/inquiries/:id/comments', () => {
    it('정상 admin 댓글 → 201 + status IN_PROGRESS 전환', async () => {
      const { user } = await signInAsUser(app);
      const { accessToken: adminToken } = await signInAsAdmin(app);
      const inquiry = await seedInquiry(user.id);

      const res = await request(app.getHttpServer())
        .post(`/admin/inquiries/${inquiry.id}/comments`)
        .set(bearer(adminToken))
        .send({ content: '답변입니다' })
        .expect(201);

      expect(res.body.data).toHaveProperty('id');
      expect(res.body.data.author_role).toBe('admin');
      expect(res.body.data.content).toBe('답변입니다');

      // status 자동 전환 검증
      const updated = await app
        .get(DataSource)
        .getRepository(Inquiry)
        .findOneBy({ id: inquiry.id });
      expect(updated?.status).toBe('IN_PROGRESS');
    });

    it('미인증 → 401', async () => {
      const { user } = await signInAsUser(app);
      const inquiry = await seedInquiry(user.id);
      return request(app.getHttpServer())
        .post(`/admin/inquiries/${inquiry.id}/comments`)
        .send({ content: 'x' })
        .expect(401);
    });

    it('role=user → 403 (RolesGuard)', async () => {
      const { user, accessToken: userToken } = await signInAsUser(app);
      const inquiry = await seedInquiry(user.id);
      return request(app.getHttpServer())
        .post(`/admin/inquiries/${inquiry.id}/comments`)
        .set(bearer(userToken))
        .send({ content: 'x' })
        .expect(403);
    });

    it('존재 안 함 inquiry → 404', async () => {
      const { accessToken: adminToken } = await signInAsAdmin(app);
      return request(app.getHttpServer())
        .post('/admin/inquiries/00000000-0000-0000-0000-000000000000/comments')
        .set(bearer(adminToken))
        .send({ content: 'x' })
        .expect(404);
    });

    it('빈 content → 400', async () => {
      const { user } = await signInAsUser(app);
      const { accessToken: adminToken } = await signInAsAdmin(app);
      const inquiry = await seedInquiry(user.id);
      return request(app.getHttpServer())
        .post(`/admin/inquiries/${inquiry.id}/comments`)
        .set(bearer(adminToken))
        .send({ content: '' })
        .expect(400);
    });

    it('2001자 content → 400 (MaxLength 2000)', async () => {
      const { user } = await signInAsUser(app);
      const { accessToken: adminToken } = await signInAsAdmin(app);
      const inquiry = await seedInquiry(user.id);
      return request(app.getHttpServer())
        .post(`/admin/inquiries/${inquiry.id}/comments`)
        .set(bearer(adminToken))
        .send({ content: 'a'.repeat(2001) })
        .expect(400);
    });

    it('unknown 필드 → 400 (forbidNonWhitelisted)', async () => {
      const { user } = await signInAsUser(app);
      const { accessToken: adminToken } = await signInAsAdmin(app);
      const inquiry = await seedInquiry(user.id);
      return request(app.getHttpServer())
        .post(`/admin/inquiries/${inquiry.id}/comments`)
        .set(bearer(adminToken))
        .send({ content: 'ok', secret: 'x' })
        .expect(400);
    });
  });

  // ── PATCH /admin/inquiries/:id/close (H-9) ────────────
  describe('PATCH /admin/inquiries/:id/close', () => {
    it('정상 → 200 + status CLOSED', async () => {
      const { user } = await signInAsUser(app);
      const { accessToken: adminToken } = await signInAsAdmin(app);
      const inquiry = await seedInquiry(user.id);

      const res = await request(app.getHttpServer())
        .patch(`/admin/inquiries/${inquiry.id}/close`)
        .set(bearer(adminToken))
        .expect(200);

      expect(res.body.data.status).toBe('CLOSED');
    });

    it('미인증 → 401', async () => {
      const { user } = await signInAsUser(app);
      const inquiry = await seedInquiry(user.id);
      return request(app.getHttpServer())
        .patch(`/admin/inquiries/${inquiry.id}/close`)
        .expect(401);
    });

    it('role=user → 403', async () => {
      const { user, accessToken: userToken } = await signInAsUser(app);
      const inquiry = await seedInquiry(user.id);
      return request(app.getHttpServer())
        .patch(`/admin/inquiries/${inquiry.id}/close`)
        .set(bearer(userToken))
        .expect(403);
    });

    it('존재 안 함 → 404', async () => {
      const { accessToken: adminToken } = await signInAsAdmin(app);
      return request(app.getHttpServer())
        .patch('/admin/inquiries/00000000-0000-0000-0000-000000000000/close')
        .set(bearer(adminToken))
        .expect(404);
    });

    it('이미 CLOSED → idempotent (200, status CLOSED 유지)', async () => {
      const { user } = await signInAsUser(app);
      const { accessToken: adminToken } = await signInAsAdmin(app);
      const inquiry = await seedInquiry(user.id);

      await request(app.getHttpServer())
        .patch(`/admin/inquiries/${inquiry.id}/close`)
        .set(bearer(adminToken))
        .expect(200);

      // 다시 close → idempotent
      const res = await request(app.getHttpServer())
        .patch(`/admin/inquiries/${inquiry.id}/close`)
        .set(bearer(adminToken))
        .expect(200);
      expect(res.body.data.status).toBe('CLOSED');
    });
  });

  // ── AD6-6: close 후 사용자 댓글 → 403 (Tier 3 PR H 회귀) ─
  describe('AD6-6 회귀: close 후 사용자 댓글 차단', () => {
    it('admin이 close한 inquiry에 user가 댓글 시도 → 403', async () => {
      const { user, accessToken: userToken } = await signInAsUser(app);
      const { accessToken: adminToken } = await signInAsAdmin(app);
      const inquiry = await seedInquiry(user.id);

      // admin이 close
      await request(app.getHttpServer())
        .patch(`/admin/inquiries/${inquiry.id}/close`)
        .set(bearer(adminToken))
        .expect(200);

      // user가 댓글 시도 → 403 (inquiries.service addUserComment의 CLOSED 검증)
      await request(app.getHttpServer())
        .post(`/inquiries/${inquiry.id}/comments`)
        .set(bearer(userToken))
        .send({ content: '추가 질문' })
        .expect(403);
    });
  });
});
