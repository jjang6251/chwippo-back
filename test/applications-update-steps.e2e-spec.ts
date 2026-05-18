/**
 * Applications updateSteps e2e (LRR P2T2 PR α — CRT-1 fix 회귀 방어).
 *
 * 핵심 검증: PUT /applications/:id/steps 호출 시 dto에 step.id를 보내면
 * 기존 step row가 재사용되어 자식 체크리스트가 cascade FK로 손실되지 않는다.
 *
 * mock 단위 spec은 cascade FK를 모사할 수 없어 실 DB에 의존.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';
import { Application } from '../src/applications/application.entity';
import { ApplicationStep } from '../src/applications/application-step.entity';
import { StepChecklistItem } from '../src/applications/step-checklist-item.entity';

describe('Applications updateSteps — checklist 보존 (e2e, PR α CRT-1)', () => {
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
   * 1) 카드 생성 (IN_PROGRESS → 기본 step 자동)
   * 2) 첫 번째 step에 checklist 2개 추가
   * 3) updateSteps 호출 (step.id 보존 + 이름만 변경)
   * 4) DB 직접 조회로 checklist 여전히 존재 확인
   */
  it('CRT-1 회귀: step 이름만 바꿔도 체크리스트는 보존됨', async () => {
    const { accessToken } = await signInAsUser(app);

    const created = await request(app.getHttpServer())
      .post('/applications')
      .set(bearer(accessToken))
      .send({ companyName: '치뽀', templateId: 'general' })
      .expect(201);

    const appId: string = created.body.data.id;
    const steps: Array<{ id: string; orderIndex: number; name: string }> =
      created.body.data.steps;
    expect(steps.length).toBeGreaterThan(0);
    const firstStepId = steps[0].id;

    // 체크리스트 2개 추가
    for (const content of ['이력서 업로드', '자소서 초안 작성']) {
      await request(app.getHttpServer())
        .post(`/applications/${appId}/steps/${firstStepId}/checklist`)
        .set(bearer(accessToken))
        .send({ content })
        .expect(201);
    }

    // 모든 step 이름만 변경 (id 보존, dto에 id 명시)
    await request(app.getHttpServer())
      .put(`/applications/${appId}/steps`)
      .set(bearer(accessToken))
      .send({
        steps: steps.map((s, i) => ({
          id: s.id,
          orderIndex: i,
          name: `${s.name} (수정)`,
        })),
      })
      .expect(200);

    // DB 검증: 첫 step의 체크리스트 여전히 2개
    const ds = app.get(DataSource);
    const remainingChecklist = await ds
      .getRepository(StepChecklistItem)
      .find({ where: { stepId: firstStepId } });
    expect(remainingChecklist).toHaveLength(2);

    // step row도 같은 id로 유지됨
    const remainingStep = await ds
      .getRepository(ApplicationStep)
      .findOneBy({ id: firstStepId });
    expect(remainingStep).not.toBeNull();
    expect(remainingStep?.name).toBe(`${steps[0].name} (수정)`);
  });

  it('dto에 없는 step만 삭제되고 그 step의 체크리스트만 cascade 삭제', async () => {
    const { accessToken } = await signInAsUser(app);

    const created = await request(app.getHttpServer())
      .post('/applications')
      .set(bearer(accessToken))
      .send({ companyName: '치뽀2', templateId: 'general' })
      .expect(201);

    const appId: string = created.body.data.id;
    const steps: Array<{ id: string; orderIndex: number; name: string }> =
      created.body.data.steps;
    const keepStepId = steps[0].id;
    const removeStepId = steps[steps.length - 1].id;

    // 보존할 step + 제거할 step 각각 체크리스트 1개
    await request(app.getHttpServer())
      .post(`/applications/${appId}/steps/${keepStepId}/checklist`)
      .set(bearer(accessToken))
      .send({ content: '보존' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/applications/${appId}/steps/${removeStepId}/checklist`)
      .set(bearer(accessToken))
      .send({ content: '함께 삭제' })
      .expect(201);

    // removeStepId 제외하고 PUT
    await request(app.getHttpServer())
      .put(`/applications/${appId}/steps`)
      .set(bearer(accessToken))
      .send({
        steps: steps
          .filter((s) => s.id !== removeStepId)
          .map((s, i) => ({ id: s.id, orderIndex: i, name: s.name })),
      })
      .expect(200);

    const ds = app.get(DataSource);
    const keepChecklist = await ds
      .getRepository(StepChecklistItem)
      .find({ where: { stepId: keepStepId } });
    expect(keepChecklist).toHaveLength(1);

    // 제거된 step과 자식은 사라짐
    const removedStep = await ds
      .getRepository(ApplicationStep)
      .findOneBy({ id: removeStepId });
    expect(removedStep).toBeNull();
    const removedChecklist = await ds
      .getRepository(StepChecklistItem)
      .find({ where: { stepId: removeStepId } });
    expect(removedChecklist).toHaveLength(0);
  });

  it('dto에 id 없는 step → 신규 INSERT (다른 step·체크리스트 영향 없음)', async () => {
    const { accessToken } = await signInAsUser(app);

    const created = await request(app.getHttpServer())
      .post('/applications')
      .set(bearer(accessToken))
      .send({ companyName: '치뽀3', templateId: 'general' })
      .expect(201);

    const appId: string = created.body.data.id;
    const steps: Array<{ id: string; orderIndex: number; name: string }> =
      created.body.data.steps;
    const firstStepId = steps[0].id;

    await request(app.getHttpServer())
      .post(`/applications/${appId}/steps/${firstStepId}/checklist`)
      .set(bearer(accessToken))
      .send({ content: '보존' })
      .expect(201);

    await request(app.getHttpServer())
      .put(`/applications/${appId}/steps`)
      .set(bearer(accessToken))
      .send({
        steps: [
          ...steps.map((s, i) => ({ id: s.id, orderIndex: i, name: s.name })),
          { orderIndex: steps.length, name: '신규 라운드' },
        ],
      })
      .expect(200);

    const ds = app.get(DataSource);
    const all = await ds
      .getRepository(ApplicationStep)
      .find({ where: { applicationId: appId }, order: { orderIndex: 'ASC' } });
    expect(all).toHaveLength(steps.length + 1);
    expect(all[all.length - 1].name).toBe('신규 라운드');

    const survived = await ds
      .getRepository(StepChecklistItem)
      .find({ where: { stepId: firstStepId } });
    expect(survived).toHaveLength(1);
  });

  it('타인 카드 → 404', async () => {
    const { user: owner } = await signInAsUser(app, { kakaoIdSuffix: 'a' });
    const { accessToken: otherToken } = await signInAsUser(app, {
      kakaoIdSuffix: 'b',
    });

    const ds = app.get(DataSource);
    const ownerApp = await ds.getRepository(Application).save(
      ds.getRepository(Application).create({
        userId: owner.id,
        companyName: '타인 카드',
        status: 'IN_PROGRESS',
      }),
    );

    await request(app.getHttpServer())
      .put(`/applications/${ownerApp.id}/steps`)
      .set(bearer(otherToken))
      .send({ steps: [{ orderIndex: 0, name: '서류' }] })
      .expect(404);
  });

  it('미인증 → 401', async () => {
    return request(app.getHttpServer())
      .put('/applications/00000000-0000-0000-0000-000000000000/steps')
      .send({ steps: [] })
      .expect(401);
  });
});
