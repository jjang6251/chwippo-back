/**
 * 준비 노트 **다중 시트** e2e — 실 DB.
 *
 * mock 단위 spec 이 원리적으로 볼 수 없는 것만 여기서 본다:
 *  E1 시트 생성 → 목록 (order_index 순서)
 *  E2 🔴 승격 멱등 — `ifEmpty: true` 두 번 → 시트 1장 · 두 번째는 **200 + 같은 id**
 *  E3 🔴 **최상위 불변식** — 승격 후 `application_steps.notes` 가 **원본 바이트 그대로**
 *     (raw SELECT + md5 실측. ORM 캐시가 아니라 디스크의 값을 본다)
 *  E4 CASCADE — 스텝이 삭제되면 그 스텝의 시트도 사라진다 (FK ON DELETE CASCADE)
 *  E5 마지막 1장 삭제 → 400
 *  E6 캡 10 경계 — 10장까지 OK · 11번째 400
 *  E7 IDOR — 타 유저 토큰으로 접근 → 404
 *  E8 이름 공백만 → 400
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { bearer, signInAsUser } from './helpers/auth';
import { createTestApp } from './helpers/bootstrap';
import { cleanAllTestUsers } from './helpers/db';

/** 기존 스텝 노트가 실제로 갖고 있는 모양 (tiptap doc JSON 문자열) */
const LEGACY_NOTES = JSON.stringify({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: '기존 노트 — 절대 안 날아간다 ✅' }],
    },
  ],
});

describe('Step note sheets (e2e)', () => {
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

  const server = () => app.getHttpServer();
  const db = () => app.get(DataSource);

  /** 카드 1장 + 기본 스텝 생성 후 (appId, stepIds) 반환 */
  async function createCard(token: string) {
    const res = await request(server())
      .post('/applications')
      .set(bearer(token))
      .send({ companyName: '시트테스트', templateId: 'general' })
      .expect(201);

    const card = res.body.data as {
      id: string;
      steps: Array<{ id: string; orderIndex: number; name: string }>;
    };
    const steps = [...card.steps].sort((a, b) => a.orderIndex - b.orderIndex);
    return { appId: card.id, steps };
  }

  const sheetsUrl = (appId: string, stepId: string) =>
    `/applications/${appId}/steps/${stepId}/note-sheets`;

  it('E1) 시트 생성 → 목록에 order_index 순으로 실린다', async () => {
    const { accessToken } = await signInAsUser(app);
    const { appId, steps } = await createCard(accessToken);
    const url = sheetsUrl(appId, steps[0].id);

    const first = await request(server())
      .post(url)
      .set(bearer(accessToken))
      .send({ name: '자소서 초안', content: LEGACY_NOTES })
      .expect(201);
    expect(first.body.data.orderIndex).toBe(0);
    expect(first.body.data.name).toBe('자소서 초안');
    // 응답에 소유자 식별자가 실리지 않는다
    expect(first.body.data.userId).toBeUndefined();

    const second = await request(server())
      .post(url)
      .set(bearer(accessToken))
      .send({ name: '면접 예상질문' })
      .expect(201);
    expect(second.body.data.orderIndex).toBe(1);
    expect(second.body.data.content).toBeNull();

    const list = await request(server())
      .get(url)
      .set(bearer(accessToken))
      .expect(200);
    expect(
      (list.body.data as Array<{ name: string }>).map((s) => s.name),
    ).toEqual(['자소서 초안', '면접 예상질문']);
  });

  it('E1b) 시트 0장 → 빈 배열 (서버가 폴백 시트를 지어내지 않는다)', async () => {
    const { accessToken } = await signInAsUser(app);
    const { appId, steps } = await createCard(accessToken);

    const res = await request(server())
      .get(sheetsUrl(appId, steps[0].id))
      .set(bearer(accessToken))
      .expect(200);

    expect(res.body.data).toEqual([]);
  });

  it('E2) 🔴 ifEmpty 승격 멱등 — 두 번 보내도 시트 1장 · 두 번째는 200 + 같은 id', async () => {
    const { accessToken } = await signInAsUser(app);
    const { appId, steps } = await createCard(accessToken);
    const url = sheetsUrl(appId, steps[0].id);

    const promoted = await request(server())
      .post(url)
      .set(bearer(accessToken))
      .send({ name: '노트', content: LEGACY_NOTES, ifEmpty: true })
      .expect(201);

    // 더블 세이브·멀티탭이 같은 승격을 또 보낸 상황
    const again = await request(server())
      .post(url)
      .set(bearer(accessToken))
      .send({ name: '노트', content: LEGACY_NOTES, ifEmpty: true })
      .expect(200);

    expect(again.body.data.id).toBe(promoted.body.data.id);

    const list = await request(server())
      .get(url)
      .set(bearer(accessToken))
      .expect(200);
    expect(list.body.data).toHaveLength(1);
  });

  it('E3) 🔴 승격 후 steps.notes 가 원본 바이트 그대로 (raw SELECT · md5 실측)', async () => {
    const { accessToken } = await signInAsUser(app);
    const { appId, steps } = await createCard(accessToken);
    const stepId = steps[0].id;

    // 기존 API 로 스텝 노트 저장 (구버전 프론트가 하던 그대로)
    await request(server())
      .patch(`/applications/${appId}/steps/${stepId}`)
      .set(bearer(accessToken))
      .send({ notes: LEGACY_NOTES })
      .expect(200);

    const before = await db().query(
      'SELECT notes, md5(notes) AS hash, length(notes) AS len FROM application_steps WHERE id = $1',
      [stepId],
    );
    expect(before[0].notes).toBe(LEGACY_NOTES);

    // 승격 + 이후 시트 편집·추가·삭제까지 전부 돌린다
    const promoted = await request(server())
      .post(sheetsUrl(appId, stepId))
      .set(bearer(accessToken))
      .send({ name: '기존 노트', content: LEGACY_NOTES, ifEmpty: true })
      .expect(201);
    await request(server())
      .post(sheetsUrl(appId, stepId))
      .set(bearer(accessToken))
      .send({ name: '두 번째' })
      .expect(201);
    await request(server())
      .patch(`${sheetsUrl(appId, stepId)}/${promoted.body.data.id}`)
      .set(bearer(accessToken))
      .send({ name: '이름 변경', content: '{"type":"doc","content":[]}' })
      .expect(200);
    await request(server())
      .delete(`${sheetsUrl(appId, stepId)}/${promoted.body.data.id}`)
      .set(bearer(accessToken))
      .expect(204);

    const after = await db().query(
      'SELECT notes, md5(notes) AS hash, length(notes) AS len FROM application_steps WHERE id = $1',
      [stepId],
    );

    expect(after[0].notes).toBe(LEGACY_NOTES);
    expect(after[0].hash).toBe(before[0].hash);
    expect(after[0].len).toBe(before[0].len);
  });

  it('E4) CASCADE — 스텝이 삭제되면 그 스텝의 시트도 사라진다', async () => {
    const { accessToken } = await signInAsUser(app);
    const { appId, steps } = await createCard(accessToken);
    const doomed = steps[1];

    await request(server())
      .post(sheetsUrl(appId, doomed.id))
      .set(bearer(accessToken))
      .send({ name: '사라질 시트' })
      .expect(201);

    const countRows = await db().query(
      'SELECT count(*)::int AS n FROM step_note_sheets WHERE step_id = $1',
      [doomed.id],
    );
    expect(countRows[0].n).toBe(1);

    // PUT /steps 에서 해당 스텝을 빼면 그 행이 hard delete 된다
    await request(server())
      .put(`/applications/${appId}/steps`)
      .set(bearer(accessToken))
      .send({
        steps: steps
          .filter((s) => s.id !== doomed.id)
          .map((s, i) => ({ id: s.id, orderIndex: i, name: s.name })),
      })
      .expect(200);

    const afterRows = await db().query(
      'SELECT count(*)::int AS n FROM step_note_sheets WHERE step_id = $1',
      [doomed.id],
    );
    expect(afterRows[0].n).toBe(0);
  });

  it('E5) 마지막 1장 삭제 → 400 · 2장이면 삭제된다', async () => {
    const { accessToken } = await signInAsUser(app);
    const { appId, steps } = await createCard(accessToken);
    const url = sheetsUrl(appId, steps[0].id);

    const only = await request(server())
      .post(url)
      .set(bearer(accessToken))
      .send({ name: '유일한 시트' })
      .expect(201);

    const blocked = await request(server())
      .delete(`${url}/${only.body.data.id}`)
      .set(bearer(accessToken))
      .expect(400);
    expect(String(blocked.body.message)).toContain('1장 이상');

    // 한 장 더 만들면 삭제가 열린다
    await request(server())
      .post(url)
      .set(bearer(accessToken))
      .send({ name: '두 번째' })
      .expect(201);
    await request(server())
      .delete(`${url}/${only.body.data.id}`)
      .set(bearer(accessToken))
      .expect(204);
  });

  it('E6) 캡 10 경계 — 10장까지 OK · 11번째 400', async () => {
    const { accessToken } = await signInAsUser(app);
    const { appId, steps } = await createCard(accessToken);
    const url = sheetsUrl(appId, steps[0].id);

    for (let i = 0; i < 10; i++) {
      await request(server())
        .post(url)
        .set(bearer(accessToken))
        .send({ name: `시트${i}` })
        .expect(201);
    }

    const over = await request(server())
      .post(url)
      .set(bearer(accessToken))
      .send({ name: '11번째' })
      .expect(400);
    expect(String(over.body.message)).toContain('10장');

    // 🔴 캡이 꽉 차 있어도 승격(ifEmpty)은 400 이 아니라 첫 시트를 돌려준다
    const promote = await request(server())
      .post(url)
      .set(bearer(accessToken))
      .send({ name: '노트', ifEmpty: true })
      .expect(200);
    expect(promote.body.data.name).toBe('시트0');
  });

  it('E7) IDOR — 타 유저 토큰으로 목록·생성·수정·삭제 전부 404', async () => {
    const { accessToken: ownerToken } = await signInAsUser(app, {
      kakaoIdSuffix: 'owner',
    });
    const { appId, steps } = await createCard(ownerToken);
    const url = sheetsUrl(appId, steps[0].id);

    const mine = await request(server())
      .post(url)
      .set(bearer(ownerToken))
      .send({ name: '내 시트' })
      .expect(201);
    await request(server())
      .post(url)
      .set(bearer(ownerToken))
      .send({ name: '내 시트2' })
      .expect(201);

    const { accessToken: attackerToken } = await signInAsUser(app, {
      kakaoIdSuffix: 'attacker',
    });

    await request(server()).get(url).set(bearer(attackerToken)).expect(404);
    await request(server())
      .post(url)
      .set(bearer(attackerToken))
      .send({ name: 'hijack' })
      .expect(404);
    await request(server())
      .patch(`${url}/${mine.body.data.id}`)
      .set(bearer(attackerToken))
      .send({ name: 'hijack' })
      .expect(404);
    await request(server())
      .delete(`${url}/${mine.body.data.id}`)
      .set(bearer(attackerToken))
      .expect(404);
  });

  it('E7b) IDOR — 본인 카드 + 다른 카드의 stepId 조합 → 404', async () => {
    const { accessToken } = await signInAsUser(app);
    const cardA = await createCard(accessToken);
    const cardB = await createCard(accessToken);

    await request(server())
      .get(sheetsUrl(cardA.appId, cardB.steps[0].id))
      .set(bearer(accessToken))
      .expect(404);
    await request(server())
      .post(sheetsUrl(cardA.appId, cardB.steps[0].id))
      .set(bearer(accessToken))
      .send({ name: 'hijack' })
      .expect(404);
  });

  it('E8) 이름 경계 — 공백만 400 · 앞뒤 공백 포함 52자는 trim 후 통과', async () => {
    const { accessToken } = await signInAsUser(app);
    const { appId, steps } = await createCard(accessToken);
    const url = sheetsUrl(appId, steps[0].id);

    const blank = await request(server())
      .post(url)
      .set(bearer(accessToken))
      .send({ name: '   ' })
      .expect(400);
    expect(String(blank.body.message)).toContain('1~50');

    const core = 'ㄱ'.repeat(50);
    const ok = await request(server())
      .post(url)
      .set(bearer(accessToken))
      .send({ name: ` ${core} ` })
      .expect(201);
    expect(ok.body.data.name).toBe(core);
  });
});
