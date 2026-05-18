/**
 * Applications checklist IDOR e2e (LRR P2T2 PR β — HI-1 fix 회귀 방어).
 *
 * 핵심 검증: PATCH·DELETE /applications/:id/steps/:stepId/checklist/:itemId 에서
 * stepId가 :id (appId)에 속하지 않는 경우 (본인 appId + 타인 stepId·itemId 조합)
 * 404 반환되어야 한다. mock 단위는 stepRepo.findOne null만 시뮬레이션 가능 —
 * e2e로 실제 다른 카드의 step/item을 만들어 통과 못 함을 확인.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';

describe('Applications checklist IDOR (e2e, PR β HI-1)', () => {
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

  /**
   * Setup: 동일 사용자가 카드 2개 생성 → 각각 첫 step에 체크리스트 1개씩.
   * 공격 시나리오: app-A의 id + app-B의 stepId·itemId 조합으로 PATCH/DELETE.
   * 기대: stepId가 app-A에 속하지 않아 404.
   */
  async function setupTwoCards(token: string) {
    const a = await request(app.getHttpServer())
      .post('/applications')
      .set(bearer(token))
      .send({ companyName: '카드A', templateId: 'general' })
      .expect(201);
    const b = await request(app.getHttpServer())
      .post('/applications')
      .set(bearer(token))
      .send({ companyName: '카드B', templateId: 'general' })
      .expect(201);

    const appA = a.body.data as {
      id: string;
      steps: Array<{ id: string }>;
    };
    const appB = b.body.data as {
      id: string;
      steps: Array<{ id: string }>;
    };

    const itemA = await request(app.getHttpServer())
      .post(`/applications/${appA.id}/steps/${appA.steps[0].id}/checklist`)
      .set(bearer(token))
      .send({ content: '카드A 항목' })
      .expect(201);
    const itemB = await request(app.getHttpServer())
      .post(`/applications/${appB.id}/steps/${appB.steps[0].id}/checklist`)
      .set(bearer(token))
      .send({ content: '카드B 항목' })
      .expect(201);

    return {
      appA: {
        id: appA.id,
        stepId: appA.steps[0].id,
        itemId: itemA.body.data.id,
      },
      appB: {
        id: appB.id,
        stepId: appB.steps[0].id,
        itemId: itemB.body.data.id,
      },
    };
  }

  it('PATCH: 본인 appA + 다른 카드 stepId·itemId → 404 (stepId 소속 검증)', async () => {
    const { accessToken } = await signInAsUser(app);
    const { appA, appB } = await setupTwoCards(accessToken);

    await request(app.getHttpServer())
      .patch(
        `/applications/${appA.id}/steps/${appB.stepId}/checklist/${appB.itemId}`,
      )
      .set(bearer(accessToken))
      .send({ content: 'hijack' })
      .expect(404);
  });

  it('DELETE: 본인 appA + 다른 카드 stepId·itemId → 404', async () => {
    const { accessToken } = await signInAsUser(app);
    const { appA, appB } = await setupTwoCards(accessToken);

    await request(app.getHttpServer())
      .delete(
        `/applications/${appA.id}/steps/${appB.stepId}/checklist/${appB.itemId}`,
      )
      .set(bearer(accessToken))
      .expect(404);
  });

  it('PATCH: 정상 (본인 app + 본인 step·item) → 200', async () => {
    const { accessToken } = await signInAsUser(app);
    const { appA } = await setupTwoCards(accessToken);

    await request(app.getHttpServer())
      .patch(
        `/applications/${appA.id}/steps/${appA.stepId}/checklist/${appA.itemId}`,
      )
      .set(bearer(accessToken))
      .send({ content: '수정' })
      .expect(200);
  });

  it('DELETE: 정상 → 204', async () => {
    const { accessToken } = await signInAsUser(app);
    const { appA } = await setupTwoCards(accessToken);

    await request(app.getHttpServer())
      .delete(
        `/applications/${appA.id}/steps/${appA.stepId}/checklist/${appA.itemId}`,
      )
      .set(bearer(accessToken))
      .expect(204);
  });

  it('PATCH: 타인 사용자의 app 시도 → 404', async () => {
    const { accessToken: ownerToken } = await signInAsUser(app, {
      kakaoIdSuffix: 'a',
    });
    const { appA } = await setupTwoCards(ownerToken);
    const { accessToken: attackerToken } = await signInAsUser(app, {
      kakaoIdSuffix: 'b',
    });

    await request(app.getHttpServer())
      .patch(
        `/applications/${appA.id}/steps/${appA.stepId}/checklist/${appA.itemId}`,
      )
      .set(bearer(attackerToken))
      .send({ content: 'hijack' })
      .expect(404);
  });
});
