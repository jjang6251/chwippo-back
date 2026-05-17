/**
 * Applications updateCurrentStep e2e (LRR P2T2 PR γ — MED-2 DTO 검증).
 *
 * PATCH /applications/:id/step — stepIndex DTO class화 후 ValidationPipe whitelist·type 검증.
 * 이전엔 @Body('stepIndex') inline이라 NaN/문자열/forbidNonWhitelisted 우회 가능.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('Applications updateCurrentStep DTO (e2e, PR γ MED-2)', () => {
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

  async function createCard(token: string) {
    const res = await request(app.getHttpServer())
      .post('/applications')
      .set(bearer(token))
      .send({ companyName: '치뽀', templateId: 'general' })
      .expect(201);
    return res.body.data as {
      id: string;
      steps: Array<{ id: string }>;
    };
  }

  it('정상 stepIndex=0 → 200', async () => {
    const { accessToken } = await signInAsUser(app);
    const card = await createCard(accessToken);
    await request(app.getHttpServer())
      .patch(`/applications/${card.id}/step`)
      .set(bearer(accessToken))
      .send({ stepIndex: 0 })
      .expect(200);
  });

  it('stepIndex 문자열 → 400 (IsInt)', async () => {
    const { accessToken } = await signInAsUser(app);
    const card = await createCard(accessToken);
    await request(app.getHttpServer())
      .patch(`/applications/${card.id}/step`)
      .set(bearer(accessToken))
      .send({ stepIndex: 'abc' })
      .expect(400);
  });

  it('stepIndex 음수 → 400 (Min(0))', async () => {
    const { accessToken } = await signInAsUser(app);
    const card = await createCard(accessToken);
    await request(app.getHttpServer())
      .patch(`/applications/${card.id}/step`)
      .set(bearer(accessToken))
      .send({ stepIndex: -1 })
      .expect(400);
  });

  it('stepIndex 누락 → 400', async () => {
    const { accessToken } = await signInAsUser(app);
    const card = await createCard(accessToken);
    await request(app.getHttpServer())
      .patch(`/applications/${card.id}/step`)
      .set(bearer(accessToken))
      .send({})
      .expect(400);
  });

  it('forbidNonWhitelisted (evilField 포함) → 400', async () => {
    const { accessToken } = await signInAsUser(app);
    const card = await createCard(accessToken);
    await request(app.getHttpServer())
      .patch(`/applications/${card.id}/step`)
      .set(bearer(accessToken))
      .send({ stepIndex: 0, evilField: 'x' })
      .expect(400);
  });

  it('stepIndex 범위 초과 (steps.length 이상) → 403 (서비스 ForbiddenException)', async () => {
    const { accessToken } = await signInAsUser(app);
    const card = await createCard(accessToken);
    await request(app.getHttpServer())
      .patch(`/applications/${card.id}/step`)
      .set(bearer(accessToken))
      .send({ stepIndex: 100 })
      .expect(403);
  });
});
