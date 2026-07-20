/**
 * Tier 2 DTO 검증 강화 e2e (LRR P2T2 PR δ).
 *
 * - DTO-1: UpdateStepDetailDto.scheduledDate IsISO8601 (이전 IsString만)
 * - DTO-2: UpdateStepDetailDto.location MaxLength(100)
 * - DTO-8: UpdateProfileDto.email_personal IsEmail
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('Tier 2 DTO 검증 강화 (e2e, PR δ)', () => {
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

  // ── DTO-1·2 UpdateStepDetailDto ─────────────────────────
  describe('PATCH /applications/:id/steps/:stepId (DTO-1·2)', () => {
    async function createCardWithStep(token: string) {
      const res = await request(app.getHttpServer())
        .post('/applications')
        .set(bearer(token))
        .send({ companyName: '치뽀', templateId: 'general' })
        .expect(201);
      return {
        appId: res.body.data.id as string,
        stepId: res.body.data.steps[0].id as string,
      };
    }

    it('DTO-1: scheduledDate가 ISO8601 아님 → 400', async () => {
      const { accessToken } = await signInAsUser(app);
      const { appId, stepId } = await createCardWithStep(accessToken);
      await request(app.getHttpServer())
        .patch(`/applications/${appId}/steps/${stepId}`)
        .set(bearer(accessToken))
        .send({ scheduledDate: 'not-a-date' })
        .expect(400);
    });

    it('DTO-1: scheduledDate ISO8601 → 200', async () => {
      const { accessToken } = await signInAsUser(app);
      const { appId, stepId } = await createCardWithStep(accessToken);
      await request(app.getHttpServer())
        .patch(`/applications/${appId}/steps/${stepId}`)
        .set(bearer(accessToken))
        .send({ scheduledDate: '2026-06-01T09:00:00Z' })
        .expect(200);
    });

    it('DTO-2: location 101자 → 400 (MaxLength 100)', async () => {
      const { accessToken } = await signInAsUser(app);
      const { appId, stepId } = await createCardWithStep(accessToken);
      await request(app.getHttpServer())
        .patch(`/applications/${appId}/steps/${stepId}`)
        .set(bearer(accessToken))
        .send({ location: 'a'.repeat(101) })
        .expect(400);
    });

    it('DTO-2: location 100자 (경계값) → 200', async () => {
      const { accessToken } = await signInAsUser(app);
      const { appId, stepId } = await createCardWithStep(accessToken);
      await request(app.getHttpServer())
        .patch(`/applications/${appId}/steps/${stepId}`)
        .set(bearer(accessToken))
        .send({ location: 'a'.repeat(100) })
        .expect(200);
    });
  });

  // ── UpdateApplicationDto.memo — tiptap JSON 상한 (카드 상세 개편) ──
  describe('PATCH /applications/:id (memo MaxLength 100_000)', () => {
    async function createCard(token: string) {
      const res = await request(app.getHttpServer())
        .post('/applications')
        .set(bearer(token))
        .send({ companyName: '치뽀', templateId: 'general' })
        .expect(201);
      return res.body.data.id as string;
    }

    it('memo 2000자 초과 tiptap JSON → 200 (텍스트 2000자의 JSON 오버헤드 수용 — 구 MaxLength(2000) 회귀 방지)', async () => {
      const { accessToken } = await signInAsUser(app);
      const appId = await createCard(accessToken);
      // 텍스트 ~1800자 tiptap 문서 — 직렬화하면 2000자를 넘는다 (구 제약이면 400 났던 케이스)
      const memo = JSON.stringify({
        type: 'doc',
        content: Array.from({ length: 30 }, () => ({
          type: 'paragraph',
          content: [{ type: 'text', text: '가'.repeat(60) }],
        })),
      });
      expect(memo.length).toBeGreaterThan(2000);
      await request(app.getHttpServer())
        .patch(`/applications/${appId}`)
        .set(bearer(accessToken))
        .send({ memo })
        .expect(200);
    });

    it('memo 100_000자 초과 → 400 (상한 유지)', async () => {
      const { accessToken } = await signInAsUser(app);
      const appId = await createCard(accessToken);
      await request(app.getHttpServer())
        .patch(`/applications/${appId}`)
        .set(bearer(accessToken))
        .send({ memo: 'a'.repeat(100_001) })
        .expect(400);
    });
  });

  // ── DTO-8 UpdateProfileDto.email_personal ───────────────
  describe('PATCH /myinfo/profile (DTO-8)', () => {
    it('DTO-8: email_personal 잘못된 형식 → 400', async () => {
      const { accessToken } = await signInAsUser(app);
      await request(app.getHttpServer())
        .patch('/myinfo/profile')
        .set(bearer(accessToken))
        .send({ email_personal: 'not-an-email' })
        .expect(400);
    });

    it('DTO-8: email_personal 정상 → 200', async () => {
      const { accessToken } = await signInAsUser(app);
      await request(app.getHttpServer())
        .patch('/myinfo/profile')
        .set(bearer(accessToken))
        .send({ email_personal: 'me@example.com' })
        .expect(200);
    });

    it('DTO-8: email_personal 빈 문자열 → EmptyToUndef로 통과 (200)', async () => {
      const { accessToken } = await signInAsUser(app);
      await request(app.getHttpServer())
        .patch('/myinfo/profile')
        .set(bearer(accessToken))
        .send({ email_personal: '' })
        .expect(200);
    });
  });
});
