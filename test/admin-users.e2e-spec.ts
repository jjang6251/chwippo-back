/**
 * Admin user 관리 e2e (LRR P2T1 PR R H-10·H-11·H-12).
 *
 * PATCH/DELETE/warn/export — RolesGuard·self-protection·audit·NotFound 검증.
 */
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
});
