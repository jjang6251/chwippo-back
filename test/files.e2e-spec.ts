/**
 * Files 라우트 e2e (LRR P2T1 PR S H-13·H-14).
 *
 * POST /files/presigned-url — scope·contentType·fileSize 화이트리스트·경계값·DTO
 * DELETE /files — ownership 검증 (본인 prefix), DTO, 401, R2 실패 swallow
 *
 * S3·presigner 외부 의존은 jest.mock으로 차단 (실 R2 호출 없음).
 */
import { mockS3, mockGetSignedUrl } from './helpers/r2-mock';

const s3Mock = mockS3();
const presignerMock = mockGetSignedUrl();

jest.mock('@aws-sdk/client-s3', () => s3Mock);
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: presignerMock,
}));

// R2_PUBLIC_URL이 빈 값이면 assertOwnFileUrl가 silently skip → 본 테스트 의미 상실.
// 로컬 .env엔 file-dev.chwippo.com이 있지만 CI에선 미설정 — 테스트 진입 직전 강제 주입.
process.env.R2_PUBLIC_URL =
  process.env.R2_PUBLIC_URL || 'https://file-test.example.com';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('Files (e2e, H-13·H-14)', () => {
  let app: INestApplication<App>;
  const PUBLIC = process.env.R2_PUBLIC_URL!.replace(/\/$/, '');

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await cleanAllTestUsers(app);
    await app.close();
  });

  beforeEach(() => {
    s3Mock.send.mockClear();
    presignerMock.mockClear();
  });

  afterEach(async () => {
    await cleanAllTestUsers(app);
  });

  // ── POST /files/presigned-url (H-13) ──────────────────
  describe('POST /files/presigned-url', () => {
    const goodBody = {
      scope: 'myinfo/cert',
      contentType: 'application/pdf',
      fileSize: 1024,
    };

    it('정상 (pdf + 정상 size) → 200 + uploadUrl + fileUrl with user prefix', async () => {
      const { user, accessToken } = await signInAsUser(app);
      const res = await request(app.getHttpServer())
        .post('/files/presigned-url')
        .set(bearer(accessToken))
        .send(goodBody)
        .expect(201);

      expect(res.body.data.uploadUrl).toBeDefined();
      expect(res.body.data.fileUrl).toMatch(
        new RegExp(`^${PUBLIC}/users/${user.id}/myinfo/cert/.+\\.pdf$`),
      );
      expect(presignerMock).toHaveBeenCalledTimes(1);
    });

    it('contentType=image/jpeg → 200 + .jpg 확장자', async () => {
      const { accessToken } = await signInAsUser(app);
      const res = await request(app.getHttpServer())
        .post('/files/presigned-url')
        .set(bearer(accessToken))
        .send({ ...goodBody, contentType: 'image/jpeg' })
        .expect(201);
      expect(res.body.data.fileUrl).toMatch(/\.jpg$/);
    });

    it('contentType=image/png → 200 + .png 확장자', async () => {
      const { accessToken } = await signInAsUser(app);
      const res = await request(app.getHttpServer())
        .post('/files/presigned-url')
        .set(bearer(accessToken))
        .send({ ...goodBody, contentType: 'image/png' })
        .expect(201);
      expect(res.body.data.fileUrl).toMatch(/\.png$/);
    });

    it('scope 허용 목록 외 ("evil/scope") → 400', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .post('/files/presigned-url')
        .set(bearer(accessToken))
        .send({ ...goodBody, scope: 'evil/scope' })
        .expect(400);
    });

    it('scope path injection ("../../etc/passwd") → 400', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .post('/files/presigned-url')
        .set(bearer(accessToken))
        .send({ ...goodBody, scope: '../../etc/passwd' })
        .expect(400);
    });

    it('contentType=image/gif → 400 (허용 안 됨)', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .post('/files/presigned-url')
        .set(bearer(accessToken))
        .send({ ...goodBody, contentType: 'image/gif' })
        .expect(400);
    });

    it('contentType=text/plain → 400', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .post('/files/presigned-url')
        .set(bearer(accessToken))
        .send({ ...goodBody, contentType: 'text/plain' })
        .expect(400);
    });

    it('fileSize=0 → 400 (Min 1)', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .post('/files/presigned-url')
        .set(bearer(accessToken))
        .send({ ...goodBody, fileSize: 0 })
        .expect(400);
    });

    it('fileSize=10MB+1 → 400 (Max 10MB)', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .post('/files/presigned-url')
        .set(bearer(accessToken))
        .send({ ...goodBody, fileSize: 10 * 1024 * 1024 + 1 })
        .expect(400);
    });

    it('fileSize=10MB (경계값) → 200', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .post('/files/presigned-url')
        .set(bearer(accessToken))
        .send({ ...goodBody, fileSize: 10 * 1024 * 1024 })
        .expect(201);
    });

    it('fileSize=1 (경계값 하한) → 200', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .post('/files/presigned-url')
        .set(bearer(accessToken))
        .send({ ...goodBody, fileSize: 1 })
        .expect(201);
    });

    it('fileSize 문자열 → 400 (IsNumber)', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .post('/files/presigned-url')
        .set(bearer(accessToken))
        .send({ ...goodBody, fileSize: 'abc' })
        .expect(400);
    });

    it('scope 누락 → 400 (DTO)', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .post('/files/presigned-url')
        .set(bearer(accessToken))
        .send({ contentType: 'application/pdf', fileSize: 1024 })
        .expect(400);
    });

    it('미허용 필드 (forbidNonWhitelisted) → 400', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .post('/files/presigned-url')
        .set(bearer(accessToken))
        .send({ ...goodBody, evilField: 'x' })
        .expect(400);
    });

    it('미인증 → 401', async () => {
      return request(app.getHttpServer())
        .post('/files/presigned-url')
        .send(goodBody)
        .expect(401);
    });
  });

  // ── DELETE /files (H-14) ──────────────────────────────
  describe('DELETE /files', () => {
    it('정상 본인 파일 → 204 + R2 DeleteObject 호출', async () => {
      const { user, accessToken } = await signInAsUser(app);
      const fileUrl = `${PUBLIC}/users/${user.id}/myinfo/cert/abc.pdf`;

      await request(app.getHttpServer())
        .delete('/files')
        .set(bearer(accessToken))
        .send({ fileUrl })
        .expect(204);

      expect(s3Mock.send).toHaveBeenCalledTimes(1);
      expect(s3Mock.DeleteObjectCommand).toHaveBeenCalledWith({
        Bucket: expect.any(String),
        Key: `users/${user.id}/myinfo/cert/abc.pdf`,
      });
    });

    it('타인 파일 URL → 403 + R2 호출 없음 (ownership 검증)', async () => {
      const { accessToken } = await signInAsUser(app, { kakaoIdSuffix: 'a' });
      const otherUserId = '00000000-0000-0000-0000-000000000999';
      const fileUrl = `${PUBLIC}/users/${otherUserId}/myinfo/cert/x.pdf`;

      await request(app.getHttpServer())
        .delete('/files')
        .set(bearer(accessToken))
        .send({ fileUrl })
        .expect(403);

      expect(s3Mock.send).not.toHaveBeenCalled();
    });

    it('fileUrl 누락 → 400 (DTO)', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .delete('/files')
        .set(bearer(accessToken))
        .send({})
        .expect(400);
    });

    it('fileUrl이 URL 형식 아님 → 400 (IsUrl)', async () => {
      const { accessToken } = await signInAsUser(app);
      return request(app.getHttpServer())
        .delete('/files')
        .set(bearer(accessToken))
        .send({ fileUrl: 'not-a-url' })
        .expect(400);
    });

    it('미인증 → 401', async () => {
      const fileUrl = `${PUBLIC}/users/00000000-0000-0000-0000-000000000001/myinfo/cert/x.pdf`;
      return request(app.getHttpServer())
        .delete('/files')
        .send({ fileUrl })
        .expect(401);
    });

    it('R2 호출 실패해도 swallow → 204 (DB는 이미 삭제, 고아 파일 무해)', async () => {
      const { user, accessToken } = await signInAsUser(app);
      s3Mock.send.mockRejectedValueOnce(new Error('R2 일시 장애'));

      await request(app.getHttpServer())
        .delete('/files')
        .set(bearer(accessToken))
        .send({ fileUrl: `${PUBLIC}/users/${user.id}/myinfo/cert/x.pdf` })
        .expect(204);
    });
  });
});
