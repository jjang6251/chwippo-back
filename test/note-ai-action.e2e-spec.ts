/**
 * **노트 AI 패널** e2e — 실 DB.
 *
 * mock 단위 spec 이 원리적으로 볼 수 없는 것만 여기서 본다
 * (앱 부팅·라우팅·가드·ValidationPipe·실 SQL·FK CASCADE·feature 시드 행).
 *
 *  E0  🔴 **앱이 뜬다** — StudyNotesModule → AiModule 배선의 전이 순환 검증
 *      (AiModule 은 ActivityModule·AdminModule 을 forwardRef 로 갖고 있다.
 *       순환이면 부팅 자체가 실패한다 — 2026-08-08 CI E2E 210 전량 실패 전례)
 *  E1  🔴 401 — 토큰 없이 두 엔드포인트
 *  E2  🔴 IDOR — 타인 노트·타인 카드/스텝 404 · 없는 id 404 · uuid 아닌 id 400
 *  E3  입력 캡 — 선택 6,000/6,001 · 지시 500/501 · 히스토리 6/7항목 · 항목 4,000/4,001
 *       · 잘못된 action · 선택·지시 둘 다 빈 값 · 공백만 (전부 400, 문구에 숫자)
 *  E4  봉투 — 동의 전 사용자는 `blocked_consent` + quota 스냅샷 (generic 실패로 안 뭉갠다)
 *  E5  🔴 캐시 hit — 24h 내 동일 hash → LLM 미호출(llm_call_logs 0행) · `cached: true`
 *  E5b 🔴 24h 초과 → miss + 만료 행 lazy 삭제
 *  E5c 🔴 user 격리 — 남의 hash 는 안 쓴다
 *  E6  🔴 탈퇴 CASCADE — user 삭제 시 캐시 행 소멸
 *  E7  🔴 feature 시드 — coin_meta(charges=true·fixed=2) · quota 3 tier · model_config
 *       (없으면 무료로 새어나가거나 FALLBACK 한도가 조용히 걸린다)
 */
import { createHash } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { bearer, signInAsUser } from './helpers/auth';
import { createTestApp } from './helpers/bootstrap';
import { cleanAllTestUsers } from './helpers/db';

const SELECTION =
  '프로세스는 실행 중인 프로그램이고, 스레드는 그 안의 실행 흐름이다.';

/**
 * 🔴 서버의 입력 해시 정규화를 **의도적으로 복제**한다.
 * 이 규칙이 바뀌면 운영에 쌓인 캐시가 전부 무효가 된다 — 조용히 바뀌면 안 되는 계약이라
 * 여기서 잠근다 (`NoteAiActionService.hashInput` 과 짝).
 */
const inputHashOf = (args: {
  action: string;
  selectionMd?: string;
  instruction?: string;
  history?: Array<{ role: string; text: string }>;
}) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        action: args.action,
        selectionMd: args.selectionMd ?? '',
        instruction: args.instruction ?? '',
        history: (args.history ?? []).map((h) => [h.role, h.text]),
      }),
    )
    .digest('hex');

describe('Note AI action (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    // E0 — 여기서 터지면 모듈 순환이다 (다른 모든 케이스보다 먼저 드러난다)
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

  const createNote = async (token: string): Promise<string> => {
    const res = await request(server())
      .post('/study-notes')
      .set(bearer(token))
      .send({ title: 'CS 정리' })
      .expect(201);
    return (res.body.data as { id: string }).id;
  };

  const createCardStep = async (token: string, companyName: string) => {
    const res = await request(server())
      .post('/applications')
      .set(bearer(token))
      .send({ companyName, templateId: 'general' })
      .expect(201);
    const body = res.body.data as {
      id: string;
      steps: Array<{ id: string; orderIndex: number }>;
    };
    const step = [...body.steps].sort((a, b) => a.orderIndex - b.orderIndex)[0];
    return { appId: body.id, stepId: step.id };
  };

  const noteUrl = (id: string) => `/study-notes/${id}/ai-action`;
  const stepUrl = (appId: string, stepId: string) =>
    `/applications/${appId}/steps/${stepId}/ai-action`;

  // ── E0 ──

  it('E0) 🔴 앱이 뜬다 — 두 엔드포인트가 라우팅 테이블에 있다 (모듈 순환 없음)', async () => {
    expect(app).toBeDefined();

    // 401 = 라우트가 존재하고 전역 JWT 가드가 잡았다는 뜻 (404 면 라우트 자체가 없다)
    const uuid = '11111111-1111-4111-8111-111111111111';
    await request(server()).post(noteUrl(uuid)).send({}).expect(401);
    await request(server()).post(stepUrl(uuid, uuid)).send({}).expect(401);
  });

  // ── E1 ──

  it('E1) 🔴 토큰 없이 → 401', async () => {
    const { accessToken } = await signInAsUser(app, {
      kakaoIdSuffix: 'noauth',
    });
    const noteId = await createNote(accessToken);
    const { appId, stepId } = await createCardStep(accessToken, '무인증');

    await request(server())
      .post(noteUrl(noteId))
      .send({ action: 'easy', selectionMd: SELECTION })
      .expect(401);
    await request(server())
      .post(stepUrl(appId, stepId))
      .send({ action: 'easy', selectionMd: SELECTION })
      .expect(401);
  });

  // ── E2 ──

  it('E2) 🔴 IDOR — 타인 노트·타인 스텝 404 · 없는 id 404 · uuid 아님 400', async () => {
    const { accessToken: owner } = await signInAsUser(app, {
      kakaoIdSuffix: 'owner',
    });
    const noteId = await createNote(owner);
    const { appId, stepId } = await createCardStep(owner, '아이도어');

    const { accessToken: attacker } = await signInAsUser(app, {
      kakaoIdSuffix: 'attacker',
    });
    const body = { action: 'easy', selectionMd: SELECTION };

    await request(server())
      .post(noteUrl(noteId))
      .set(bearer(attacker))
      .send(body)
      .expect(404);
    await request(server())
      .post(stepUrl(appId, stepId))
      .set(bearer(attacker))
      .send(body)
      .expect(404);

    // 없는 id — 존재 여부를 알려 주지 않는다
    const ghost = '99999999-9999-4999-8999-999999999999';
    await request(server())
      .post(noteUrl(ghost))
      .set(bearer(attacker))
      .send(body)
      .expect(404);
    await request(server())
      .post(stepUrl(ghost, ghost))
      .set(bearer(attacker))
      .send(body)
      .expect(404);

    // 자기 카드 + 남의 스텝 조합도 막힌다 (2-hop 을 둘 다 본다)
    const own = await createCardStep(attacker, '공격자카드');
    await request(server())
      .post(stepUrl(own.appId, stepId))
      .set(bearer(attacker))
      .send(body)
      .expect(404);

    await request(server())
      .post(noteUrl('not-a-uuid'))
      .set(bearer(attacker))
      .send(body)
      .expect(400);
  });

  // ── E3 ──

  it('E3) 입력 캡 — 경계 통과 / 초과는 400 (문구에 숫자)', async () => {
    const { accessToken } = await signInAsUser(app, { kakaoIdSuffix: 'cap' });
    const noteId = await createNote(accessToken);
    const post = (body: Record<string, unknown>) =>
      request(server())
        .post(noteUrl(noteId))
        .set(bearer(accessToken))
        .send(body);

    // 선택 6,000자 = 통과 (동의 전이라 200 봉투 안에서 blocked_consent 로 끝난다)
    await post({ action: 'easy', selectionMd: 'ㄱ'.repeat(6_000) }).expect(201);
    const overSel = await post({
      action: 'easy',
      selectionMd: 'ㄱ'.repeat(6_001),
    }).expect(400);
    expect(String(overSel.body.message)).toContain('6,000');

    // 지시 500 / 501
    await post({ action: 'free', instruction: 'ㄴ'.repeat(500) }).expect(201);
    const overInst = await post({
      action: 'free',
      instruction: 'ㄴ'.repeat(501),
    }).expect(400);
    expect(String(overInst.body.message)).toContain('500');

    // 히스토리 6항목 / 7항목
    const item = (text: string) => ({ role: 'user', text });
    await post({
      action: 'easy',
      selectionMd: SELECTION,
      history: Array.from({ length: 6 }, (_, i) => item(`턴${i}`)),
    }).expect(201);
    const overItems = await post({
      action: 'easy',
      selectionMd: SELECTION,
      history: Array.from({ length: 7 }, (_, i) => item(`턴${i}`)),
    }).expect(400);
    expect(String(overItems.body.message)).toContain('6');

    // 히스토리 항목 4,000 / 4,001자
    await post({
      action: 'easy',
      selectionMd: SELECTION,
      history: [item('ㄷ'.repeat(4_000))],
    }).expect(201);
    const overItem = await post({
      action: 'easy',
      selectionMd: SELECTION,
      history: [item('ㄷ'.repeat(4_001))],
    }).expect(400);
    expect(String(overItem.body.message)).toContain('4,000');

    // history role 은 두 값뿐
    await post({
      action: 'easy',
      selectionMd: SELECTION,
      history: [{ role: 'system', text: '탈취' }],
    }).expect(400);

    // 잘못된 action
    await post({ action: 'hack', selectionMd: SELECTION }).expect(400);
    await post({ selectionMd: SELECTION }).expect(400);

    // 선택·지시 둘 다 없음 / 공백만 — trim 후 판정이라 둘 다 400
    const empty = await post({ action: 'easy' }).expect(400);
    expect(String(empty.body.message)).toContain('선택');
    await post({
      action: 'easy',
      selectionMd: '   ',
      instruction: ' \n ',
    }).expect(400);

    // 스키마 밖 필드는 거부 (forbidNonWhitelisted)
    await post({
      action: 'easy',
      selectionMd: SELECTION,
      contextRefs: ['x'],
    }).expect(400);
  });

  // ── E4 ──

  it('E4) 봉투 — 동의 전 사용자는 blocked_consent + quota 스냅샷', async () => {
    const { accessToken } = await signInAsUser(app, {
      kakaoIdSuffix: 'consent',
    });
    const noteId = await createNote(accessToken);

    const res = await request(server())
      .post(noteUrl(noteId))
      .set(bearer(accessToken))
      .send({ action: 'easy', selectionMd: SELECTION })
      .expect(201);

    const body = res.body.data as {
      status: string;
      reason: string;
      quota: { used: number; limit: number };
    };
    // generic '실패했어요' 로 뭉개면 사용자가 "동의하면 해결" 을 인지 못 한다
    expect(body.status).toBe('blocked_consent');
    expect(body.reason).toContain('동의');
    expect(body.quota.limit).toBeGreaterThan(0);
  });

  // ── E5 ──

  it('E5) 🔴 캐시 hit — LLM 미호출 · cached=true (새로고침 방어)', async () => {
    const { accessToken, user } = await signInAsUser(app, {
      kakaoIdSuffix: 'cache',
    });
    const noteId = await createNote(accessToken);
    const hash = inputHashOf({ action: 'table', selectionMd: SELECTION });

    await db().query(
      `INSERT INTO note_ai_action_cache (user_id, resource_type, resource_id, input_hash, result_md)
       VALUES ($1, 'study_note', $2, $3, $4)`,
      [user.id, noteId, hash, '| a | b |\n| --- | --- |'],
    );

    const res = await request(server())
      .post(noteUrl(noteId))
      .set(bearer(accessToken))
      .send({ action: 'table', selectionMd: SELECTION })
      .expect(201);

    expect(res.body.data).toMatchObject({
      status: 'ok',
      cached: true,
      markdown: '| a | b |\n| --- | --- |',
      meta: { callLogId: null },
    });

    // 무차감의 근거 — 이 사용자의 llm_call_logs 가 한 줄도 안 생겼다
    const logs = await db().query<Array<{ n: number }>>(
      'SELECT count(*)::int AS n FROM llm_call_logs WHERE user_id = $1',
      [user.id],
    );
    expect(logs[0].n).toBe(0);
  });

  it('E5b) 🔴 24h 초과 캐시는 miss + 만료 행 lazy 삭제', async () => {
    const { accessToken, user } = await signInAsUser(app, {
      kakaoIdSuffix: 'expire',
    });
    const noteId = await createNote(accessToken);
    const hash = inputHashOf({ action: 'easy', selectionMd: SELECTION });

    await db().query(
      `INSERT INTO note_ai_action_cache (user_id, resource_type, resource_id, input_hash, result_md, created_at)
       VALUES ($1, 'study_note', $2, $3, '옛 결과', now() - INTERVAL '24 hours 1 second')`,
      [user.id, noteId, hash],
    );

    const res = await request(server())
      .post(noteUrl(noteId))
      .set(bearer(accessToken))
      .send({ action: 'easy', selectionMd: SELECTION })
      .expect(201);

    // 캐시를 안 썼다 → 동의 게이트까지 내려간다
    expect((res.body.data as { status: string }).status).toBe(
      'blocked_consent',
    );

    // cron 없이 조회 시점에 정리된다
    const rows = await db().query<Array<{ n: number }>>(
      'SELECT count(*)::int AS n FROM note_ai_action_cache WHERE user_id = $1',
      [user.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('E5c) 🔴 user 격리 — 같은 hash 라도 남의 캐시는 안 쓴다', async () => {
    const { user: owner } = await signInAsUser(app, {
      kakaoIdSuffix: 'cache-owner',
    });
    const { accessToken: other } = await signInAsUser(app, {
      kakaoIdSuffix: 'cache-other',
    });
    const otherNoteId = await createNote(other);
    const hash = inputHashOf({ action: 'concise', selectionMd: SELECTION });

    await db().query(
      `INSERT INTO note_ai_action_cache (user_id, resource_type, resource_id, input_hash, result_md)
       VALUES ($1, 'study_note', $2, $3, '남의 결과')`,
      [owner.id, otherNoteId, hash],
    );

    const res = await request(server())
      .post(noteUrl(otherNoteId))
      .set(bearer(other))
      .send({ action: 'concise', selectionMd: SELECTION })
      .expect(201);

    const body = res.body.data as { status: string; markdown?: string };
    expect(body.status).toBe('blocked_consent');
    expect(body.markdown).toBeUndefined();
  });

  // ── E6 ──

  it('E6) 🔴 탈퇴 CASCADE — user 삭제 시 캐시 행 소멸', async () => {
    const { accessToken, user } = await signInAsUser(app, {
      kakaoIdSuffix: 'cascade',
    });
    const noteId = await createNote(accessToken);

    await db().query(
      `INSERT INTO note_ai_action_cache (user_id, resource_type, resource_id, input_hash, result_md)
       VALUES ($1, 'study_note', $2, $3, '결과')`,
      [user.id, noteId, 'a'.repeat(64)],
    );
    const before = await db().query<Array<{ n: number }>>(
      'SELECT count(*)::int AS n FROM note_ai_action_cache WHERE user_id = $1',
      [user.id],
    );
    expect(before[0].n).toBe(1);

    await request(server())
      .delete('/users/me')
      .set(bearer(accessToken))
      .expect(204);

    const after = await db().query<Array<{ n: number }>>(
      'SELECT count(*)::int AS n FROM note_ai_action_cache WHERE user_id = $1',
      [user.id],
    );
    expect(after[0].n).toBe(0);
  });

  // ── E7 ──

  it('E7) 🔴 feature 시드 3표 — 없으면 무료로 새거나 FALLBACK 한도가 걸린다', async () => {
    const coin = await db().query<
      Array<{
        charges_coins: boolean;
        avg_coin_cost: string;
        fixed_coin_cost: number | null;
      }>
    >(
      `SELECT charges_coins, avg_coin_cost, fixed_coin_cost FROM feature_coin_meta WHERE feature = 'note_ai_action'`,
    );
    expect(coin).toHaveLength(1);
    // charges_coins=false 면 in-flight lock 도 안 걸려 연타가 그대로 통과한다
    expect(coin[0].charges_coins).toBe(true);
    // 토큰 환산 차감 (2026-08-19 D1 개정 — 고정 2 → 기본 방식). fixed 는 비워야 환산이 돈다
    expect(coin[0].fixed_coin_cost).toBeNull();
    expect(Number(coin[0].avg_coin_cost)).toBe(1);

    const quotas = await db().query<Array<{ tier: string }>>(
      `SELECT tier FROM feature_quota_configs WHERE feature = 'note_ai_action' ORDER BY tier`,
    );
    expect(quotas.map((q) => q.tier)).toEqual(['free', 'lite', 'standard']);

    const model = await db().query<Array<{ provider: string; model: string }>>(
      `SELECT provider, model FROM feature_model_config WHERE feature = 'note_ai_action'`,
    );
    expect(model).toEqual([{ provider: 'openai', model: 'gpt-5.6-luna' }]);
  });
});
