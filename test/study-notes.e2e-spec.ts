/**
 * **공부 노트** e2e — 실 DB.
 *
 * mock 단위 spec 이 원리적으로 볼 수 없는 것만 여기서 본다 (FK 동작·실 SQL·실 트랜잭션).
 *
 *  E1  노트 CRUD 왕복 · 목록은 **본문을 안 싣는다** · `backlinkCount` 필드
 *  E1b 🔴 backlinkCount — study+prep_sheet 섞여 2 · 무참조 0 · **남이 심은 링크 미집계**
 *  E2  🔴 401 — 토큰 없이 전 라우트
 *  E3  🔴 IDOR — 타 유저 토큰으로 노트·폴더·백링크 전부 404
 *  E4  경계 — 제목 0/100/101 · content 100K−1/100K/100K+1 · 폴더명 0/1/50/51
 *  E5  캡 — 폴더 50개 경계 (49/50/51) · 노트 캡 문구
 *  E6  🔴 폴더 삭제 → 소속 노트 folder_id **NULL** (SET NULL 실측) · 노트는 살아 있다
 *  E7  폴더 1단 제약 — 자식 폴더를 parent 로 지정 → 400
 *  E8  🔴 링크 재계산 — 멘션 추가·제거가 백링크에 그대로 반영
 *  E9  🔴 가리켜진 노트 삭제 → 그 링크는 **CASCADE 로 소멸** (끊긴 링크가 안 남는다)
 *  E10 🔴 prep_sheet 소스 백링크 — 준비 노트 시트에서 멘션 → 회사·스텝 라벨 + 딥링크 id
 *  E10b 🔴 시트 삭제 → 그 시트가 내보낸 링크 행도 소멸 (고아 0 · from 쪽엔 FK 가 없다)
 *  E11 자기 자신 멘션 → 무해 (500 없음)
 *  E12 허브 — `GET /study-notes/hub/prep` 카드-스텝 그룹 (시트 수·최종 수정)
 *  E12b 🔴 **승격 전 유산 노트**(steps.notes 만) 도 나온다 (시트 수 1)
 *       · 빈 스텝 · **빈 문서 껍데기**(에디터만 열고 나간 스텝)는 안 나온다
 *  E12c 🔴 승격 후에도 한 줄 — 두 갈래(시트 / 유산)가 같은 스텝을 중복 노출하지 않는다
 *  E13 🔴 last-write-wins — 연속 두 번 PATCH → 마지막 값
 *  E14 🔴 streak — 노트 편집 당일(KST)이 heatmap 에 잡힌다 (픽스처는 서버 응답에서 파생)
 *      · 5분 캐시를 손으로 안 비운다 = **캐시 무효화 배선까지** 검증
 *  E15 🔴 탈퇴 CASCADE — user 삭제 시 노트·폴더·링크 전멸
 *  E16 hub/folders 정적 경로가 `:id` 에 안 먹힌다 (라우트 순서)
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { bearer, signInAsUser } from './helpers/auth';
import { createTestApp } from './helpers/bootstrap';
import { cleanAllTestUsers } from './helpers/db';

/** 프론트 Tiptap 확장이 쓰는 멘션 노드 이름 (서버 상수와 같아야 한다) */
const MENTION = 'studyNoteMention';

/** 멘션을 담은 tiptap doc 문자열 */
const docWithMentions = (...noteIds: string[]) =>
  JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: noteIds.map((noteId) => ({
          type: MENTION,
          attrs: { noteId, label: '스냅샷 제목' },
        })),
      },
    ],
  });

const PLAIN_DOC = JSON.stringify({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: '정리' }] }],
});

describe('Study notes (e2e)', () => {
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

  interface NoteBody {
    id: string;
    title: string;
    folderId: string | null;
    content: string | null;
  }

  async function createNote(
    token: string,
    body: Record<string, unknown> = {},
  ): Promise<NoteBody> {
    const res = await request(server())
      .post('/study-notes')
      .set(bearer(token))
      .send(body)
      .expect(201);
    return res.body.data as NoteBody;
  }

  async function createFolder(token: string, name: string): Promise<string> {
    const res = await request(server())
      .post('/study-notes/folders')
      .set(bearer(token))
      .send({ name })
      .expect(201);
    return (res.body.data as { id: string }).id;
  }

  /** 카드 1장 + 스텝 + 시트 1장 — prep_sheet 소스 검증용 */
  async function createCardWithSheet(token: string, companyName: string) {
    const card = await request(server())
      .post('/applications')
      .set(bearer(token))
      .send({ companyName, templateId: 'general' })
      .expect(201);
    const body = card.body.data as {
      id: string;
      steps: Array<{ id: string; orderIndex: number; name: string }>;
    };
    const step = [...body.steps].sort((a, b) => a.orderIndex - b.orderIndex)[0];

    const sheet = await request(server())
      .post(`/applications/${body.id}/steps/${step.id}/note-sheets`)
      .set(bearer(token))
      .send({ name: '면접 준비' })
      .expect(201);

    return {
      appId: body.id,
      stepId: step.id,
      stepName: step.name,
      sheetId: (sheet.body.data as { id: string }).id,
    };
  }

  // ── E1 ──

  it('E1) 노트 CRUD 왕복 · 목록은 본문을 안 싣는다', async () => {
    const { accessToken } = await signInAsUser(app);

    const created = await createNote(accessToken, { title: '자료구조' });
    expect(created.title).toBe('자료구조');
    expect(created.content).toBeNull();

    await request(server())
      .patch(`/study-notes/${created.id}`)
      .set(bearer(accessToken))
      .send({ content: PLAIN_DOC })
      .expect(200);

    const detail = await request(server())
      .get(`/study-notes/${created.id}`)
      .set(bearer(accessToken))
      .expect(200);
    expect((detail.body.data as NoteBody).content).toBe(PLAIN_DOC);

    const list = await request(server())
      .get('/study-notes')
      .set(bearer(accessToken))
      .expect(200);
    const rows = list.body.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    // 🔴 목록에 본문이 실리면 허브 한 번에 수 MB 가 나간다
    expect(rows[0]).not.toHaveProperty('content');
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['backlinkCount', 'folderId', 'id', 'title', 'updatedAt'].sort(),
    );
    expect(rows[0].backlinkCount).toBe(0);

    await request(server())
      .delete(`/study-notes/${created.id}`)
      .set(bearer(accessToken))
      .expect(204);
    await request(server())
      .get(`/study-notes/${created.id}`)
      .set(bearer(accessToken))
      .expect(404);
  });

  it('E1b) 🔴 backlinkCount — 두 소스 섞여 2 · 무참조 0 · 남이 심은 링크는 미집계', async () => {
    const { accessToken, user } = await signInAsUser(app, {
      kakaoIdSuffix: 'count',
    });
    const target = await createNote(accessToken, {
      title: '많이 참조되는 노트',
    });
    const lonely = await createNote(accessToken, {
      title: '아무도 안 보는 노트',
    });
    const source = await createNote(accessToken, { title: '공부 노트 출처' });

    const countOf = async (noteId: string) => {
      const res = await request(server())
        .get('/study-notes')
        .set(bearer(accessToken))
        .expect(200);
      const rows = res.body.data as Array<{
        id: string;
        backlinkCount: number;
      }>;
      return rows.find((r) => r.id === noteId)?.backlinkCount;
    };

    // 참조 0
    expect(await countOf(target.id)).toBe(0);

    // ① 공부 노트에서 멘션
    await request(server())
      .patch(`/study-notes/${source.id}`)
      .set(bearer(accessToken))
      .send({ content: docWithMentions(target.id) })
      .expect(200);
    expect(await countOf(target.id)).toBe(1);

    // ② 준비 노트 시트에서도 멘션 → 두 소스 합쳐 2
    const { appId, stepId, sheetId } = await createCardWithSheet(
      accessToken,
      '카운트테스트',
    );
    await request(server())
      .patch(`/applications/${appId}/steps/${stepId}/note-sheets/${sheetId}`)
      .set(bearer(accessToken))
      .send({ content: docWithMentions(target.id) })
      .expect(200);
    expect(await countOf(target.id)).toBe(2);

    // 배지와 패널이 같은 숫자를 말한다
    const panel = await request(server())
      .get(`/study-notes/${target.id}/backlinks`)
      .set(bearer(accessToken))
      .expect(200);
    expect((panel.body.data as unknown[]).length).toBe(2);

    // 참조 없는 노트는 목록에서 사라지지 않고 0 이다 (LEFT JOIN 근거)
    expect(await countOf(lonely.id)).toBe(0);

    /*
      ③ 🔴 남의 문서가 내 노트를 가리키는 링크 행 — API 로는 못 만든다
         (syncStudyNoteLinks 가 소유권으로 거른다). 그래서 **직접 INSERT** 해서
         두 번째 방어선을 실측한다. 이게 집계되면 배지(3)와 패널(2)이 어긋나고,
         남의 회사명이 실린 줄이 새어 나간다.
    */
    const { user: stranger, accessToken: strangerToken } = await signInAsUser(
      app,
      { kakaoIdSuffix: 'stranger' },
    );
    const strangerNote = await createNote(strangerToken, {
      title: '남의 노트',
    });
    expect(stranger.id).not.toBe(user.id);

    await db().query(
      `INSERT INTO study_note_links (from_id, from_type, to_note_id) VALUES ($1, 'study', $2)`,
      [strangerNote.id, target.id],
    );
    const planted = await db().query<Array<{ n: number }>>(
      'SELECT count(*)::int AS n FROM study_note_links WHERE to_note_id = $1',
      [target.id],
    );
    expect(planted[0].n).toBe(3); // 행은 실제로 3줄이다

    // 그래도 배지는 2 — 패널과 같은 기준으로 센다
    expect(await countOf(target.id)).toBe(2);
    const panelAfter = await request(server())
      .get(`/study-notes/${target.id}/backlinks`)
      .set(bearer(accessToken))
      .expect(200);
    expect((panelAfter.body.data as unknown[]).length).toBe(2);
  });

  // ── E2 ──

  it('E2) 🔴 토큰 없이 전 라우트 → 401', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111';

    await request(server()).get('/study-notes').expect(401);
    await request(server()).post('/study-notes').send({}).expect(401);
    await request(server()).get(`/study-notes/${uuid}`).expect(401);
    await request(server()).patch(`/study-notes/${uuid}`).send({}).expect(401);
    await request(server()).delete(`/study-notes/${uuid}`).expect(401);
    await request(server()).get(`/study-notes/${uuid}/backlinks`).expect(401);
    await request(server()).get('/study-notes/folders').expect(401);
    await request(server())
      .post('/study-notes/folders')
      .send({ name: 'x' })
      .expect(401);
    await request(server()).get('/study-notes/hub/prep').expect(401);
  });

  // ── E3 ──

  it('E3) 🔴 IDOR — 타 유저 토큰으로 노트·폴더·백링크 전부 404', async () => {
    const { accessToken: owner } = await signInAsUser(app, {
      kakaoIdSuffix: 'owner',
    });
    const note = await createNote(owner, { title: '내 노트' });
    const folderId = await createFolder(owner, '내 폴더');

    const { accessToken: attacker } = await signInAsUser(app, {
      kakaoIdSuffix: 'attacker',
    });

    await request(server())
      .get(`/study-notes/${note.id}`)
      .set(bearer(attacker))
      .expect(404);
    await request(server())
      .patch(`/study-notes/${note.id}`)
      .set(bearer(attacker))
      .send({ title: 'hijack' })
      .expect(404);
    await request(server())
      .delete(`/study-notes/${note.id}`)
      .set(bearer(attacker))
      .expect(404);
    await request(server())
      .get(`/study-notes/${note.id}/backlinks`)
      .set(bearer(attacker))
      .expect(404);
    await request(server())
      .patch(`/study-notes/folders/${folderId}`)
      .set(bearer(attacker))
      .send({ name: 'hijack' })
      .expect(404);
    await request(server())
      .delete(`/study-notes/folders/${folderId}`)
      .set(bearer(attacker))
      .expect(404);

    // 남의 폴더로 내 노트를 옮기려는 시도 → 400 (존재 여부를 알려 주지 않는다)
    const mine = await createNote(attacker, { title: '공격자 노트' });
    await request(server())
      .patch(`/study-notes/${mine.id}`)
      .set(bearer(attacker))
      .send({ folderId })
      .expect(400);

    // 목록은 서로 안 보인다
    const list = await request(server())
      .get('/study-notes')
      .set(bearer(attacker))
      .expect(200);
    expect(list.body.data).toHaveLength(1);
  });

  // ── E4 ──

  it('E4) 경계 — 제목 0/100/101 · content 100K±1 · 폴더명 0/1/50/51', async () => {
    const { accessToken } = await signInAsUser(app);

    // 제목 0자 = 정상 (노션식 즉시 생성)
    const blank = await createNote(accessToken, { title: '   ' });
    expect(blank.title).toBe('');

    const t100 = 'ㄱ'.repeat(100);
    expect((await createNote(accessToken, { title: ` ${t100} ` })).title).toBe(
      t100,
    );

    const over = await request(server())
      .post('/study-notes')
      .set(bearer(accessToken))
      .send({ title: 'ㄱ'.repeat(101) })
      .expect(400);
    expect(String(over.body.message)).toContain('100자');

    // content 경계 — 문자열 길이 기준 (100,000 까지 OK · 100,001 부터 400)
    await request(server())
      .post('/study-notes')
      .set(bearer(accessToken))
      .send({ content: 'y'.repeat(99_999) })
      .expect(201);
    await request(server())
      .post('/study-notes')
      .set(bearer(accessToken))
      .send({ content: 'y'.repeat(100_000) })
      .expect(201);
    const tooBig = await request(server())
      .post('/study-notes')
      .set(bearer(accessToken))
      .send({ content: 'y'.repeat(100_001) })
      .expect(400);
    expect(String(tooBig.body.message)).toContain('100,000');

    // 폴더명 경계
    const empty = await request(server())
      .post('/study-notes/folders')
      .set(bearer(accessToken))
      .send({ name: '   ' })
      .expect(400);
    expect(String(empty.body.message)).toContain('1~50');

    await createFolder(accessToken, 'A');
    await createFolder(accessToken, 'ㄱ'.repeat(50));
    await request(server())
      .post('/study-notes/folders')
      .set(bearer(accessToken))
      .send({ name: 'ㄱ'.repeat(51) })
      .expect(400);
  });

  // ── E5 ──

  it('E5) 폴더 캡 경계 — 49개 OK · 50번째 OK · 51번째 400 (문구에 숫자)', async () => {
    const { accessToken } = await signInAsUser(app);

    for (let i = 0; i < 50; i++) {
      await createFolder(accessToken, `폴더${i}`);
    }

    const over = await request(server())
      .post('/study-notes/folders')
      .set(bearer(accessToken))
      .send({ name: '51번째' })
      .expect(400);
    expect(String(over.body.message)).toContain('50개');
    expect(String(over.body.message)).toContain('현재 50개');

    const list = await request(server())
      .get('/study-notes/folders')
      .set(bearer(accessToken))
      .expect(200);
    expect(list.body.data).toHaveLength(50);
  });

  // ── E6 ──

  it('E6) 🔴 폴더 삭제 → 소속 노트는 살아 있고 folder_id 만 NULL (SET NULL 실측)', async () => {
    const { accessToken } = await signInAsUser(app);
    const folderId = await createFolder(accessToken, 'CS');
    const note = await createNote(accessToken, { title: '정렬', folderId });
    expect(note.folderId).toBe(folderId);

    await request(server())
      .delete(`/study-notes/folders/${folderId}`)
      .set(bearer(accessToken))
      .expect(204);

    // ORM 캐시가 아니라 디스크의 값을 본다
    const rows = await db().query<Array<{ folder_id: string | null }>>(
      'SELECT folder_id FROM study_notes WHERE id = $1',
      [note.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].folder_id).toBeNull();

    const detail = await request(server())
      .get(`/study-notes/${note.id}`)
      .set(bearer(accessToken))
      .expect(200);
    expect((detail.body.data as NoteBody).folderId).toBeNull();
  });

  // ── E7 ──

  it('E7) 폴더 1단 제약 — 자식 폴더를 parent 로 지정하면 400', async () => {
    const { accessToken } = await signInAsUser(app);
    const top = await createFolder(accessToken, '최상위');

    const child = await request(server())
      .post('/study-notes/folders')
      .set(bearer(accessToken))
      .send({ name: '자식', parentId: top })
      .expect(201);
    const childId = (child.body.data as { id: string }).id;

    // 자식(이미 1단 아래)을 부모로 삼으면 2단 아래가 된다
    const deep = await request(server())
      .post('/study-notes/folders')
      .set(bearer(accessToken))
      .send({ name: '손자', parentId: childId })
      .expect(400);
    expect(String(deep.body.message)).toContain('1단');

    // 자식이 있는 폴더를 하위로 옮기는 것도 막는다
    await request(server())
      .patch(`/study-notes/folders/${top}`)
      .set(bearer(accessToken))
      .send({ parentId: childId })
      .expect(400);
  });

  // ── E8 ──

  it('E8) 🔴 링크 재계산 — 멘션 추가·제거가 백링크에 그대로 반영', async () => {
    const { accessToken } = await signInAsUser(app);
    const target = await createNote(accessToken, { title: '트리' });
    const source = await createNote(accessToken, { title: '그래프' });

    // 처음엔 백링크 없음
    let back = await request(server())
      .get(`/study-notes/${target.id}/backlinks`)
      .set(bearer(accessToken))
      .expect(200);
    expect(back.body.data).toEqual([]);

    // 멘션 추가
    await request(server())
      .patch(`/study-notes/${source.id}`)
      .set(bearer(accessToken))
      .send({ content: docWithMentions(target.id) })
      .expect(200);

    back = await request(server())
      .get(`/study-notes/${target.id}/backlinks`)
      .set(bearer(accessToken))
      .expect(200);
    expect(back.body.data).toEqual([
      {
        fromType: 'study',
        fromId: source.id,
        label: '그래프',
        applicationId: null,
        stepId: null,
      },
    ]);

    // 멘션 제거 → 백링크도 사라진다
    await request(server())
      .patch(`/study-notes/${source.id}`)
      .set(bearer(accessToken))
      .send({ content: PLAIN_DOC })
      .expect(200);

    back = await request(server())
      .get(`/study-notes/${target.id}/backlinks`)
      .set(bearer(accessToken))
      .expect(200);
    expect(back.body.data).toEqual([]);
  });

  it('E8b) 🔴 남의 노트를 멘션해도 링크 행이 안 생긴다 (쓰기 IDOR)', async () => {
    const { accessToken: victim } = await signInAsUser(app, {
      kakaoIdSuffix: 'victim',
    });
    const victimNote = await createNote(victim, { title: '남의 노트' });

    const { accessToken: attacker } = await signInAsUser(app, {
      kakaoIdSuffix: 'attacker2',
    });
    const attackerNote = await createNote(attacker, { title: '공격자 노트' });

    await request(server())
      .patch(`/study-notes/${attackerNote.id}`)
      .set(bearer(attacker))
      .send({ content: docWithMentions(victimNote.id) })
      .expect(200);

    // 피해자 백링크 패널에 아무것도 안 뜬다
    const back = await request(server())
      .get(`/study-notes/${victimNote.id}/backlinks`)
      .set(bearer(victim))
      .expect(200);
    expect(back.body.data).toEqual([]);

    // 링크 행 자체가 없다
    const rows = await db().query<Array<{ n: number }>>(
      'SELECT count(*)::int AS n FROM study_note_links WHERE to_note_id = $1',
      [victimNote.id],
    );
    expect(rows[0].n).toBe(0);
  });

  // ── E9 ──

  it('E9) 🔴 가리켜진 노트를 지우면 그 링크는 CASCADE 로 소멸', async () => {
    const { accessToken } = await signInAsUser(app);
    const target = await createNote(accessToken, { title: '지워질 노트' });
    const source = await createNote(accessToken, { title: '가리키는 노트' });

    await request(server())
      .patch(`/study-notes/${source.id}`)
      .set(bearer(accessToken))
      .send({ content: docWithMentions(target.id) })
      .expect(200);

    const before = await db().query<Array<{ n: number }>>(
      'SELECT count(*)::int AS n FROM study_note_links WHERE to_note_id = $1',
      [target.id],
    );
    expect(before[0].n).toBe(1);

    await request(server())
      .delete(`/study-notes/${target.id}`)
      .set(bearer(accessToken))
      .expect(204);

    const after = await db().query<Array<{ n: number }>>(
      'SELECT count(*)::int AS n FROM study_note_links WHERE to_note_id = $1',
      [target.id],
    );
    expect(after[0].n).toBe(0);

    // 가리키던 노트는 멀쩡하다 (본문의 끊긴 칩은 프론트가 「삭제된 노트」로 렌더)
    await request(server())
      .get(`/study-notes/${source.id}`)
      .set(bearer(accessToken))
      .expect(200);
  });

  it('E9b) 🔴 멘션을 내보낸 노트를 지우면 그 노트가 만든 링크도 사라진다', async () => {
    const { accessToken } = await signInAsUser(app);
    const target = await createNote(accessToken, { title: '남는 노트' });
    const source = await createNote(accessToken, { title: '지울 노트' });

    await request(server())
      .patch(`/study-notes/${source.id}`)
      .set(bearer(accessToken))
      .send({ content: docWithMentions(target.id) })
      .expect(200);

    await request(server())
      .delete(`/study-notes/${source.id}`)
      .set(bearer(accessToken))
      .expect(204);

    // from 쪽엔 FK 가 없다 — 서비스가 같은 트랜잭션에서 지운 게 근거
    const rows = await db().query<Array<{ n: number }>>(
      'SELECT count(*)::int AS n FROM study_note_links WHERE from_id = $1',
      [source.id],
    );
    expect(rows[0].n).toBe(0);
  });

  // ── E10 ──

  it('E10) 🔴 prep_sheet 소스 백링크 — 회사·스텝 라벨 + 딥링크 id', async () => {
    const { accessToken } = await signInAsUser(app);
    const note = await createNote(accessToken, { title: 'CS 딥자료' });
    const { appId, stepId, stepName, sheetId } = await createCardWithSheet(
      accessToken,
      '백링크테스트',
    );

    await request(server())
      .patch(`/applications/${appId}/steps/${stepId}/note-sheets/${sheetId}`)
      .set(bearer(accessToken))
      .send({ content: docWithMentions(note.id) })
      .expect(200);

    const back = await request(server())
      .get(`/study-notes/${note.id}/backlinks`)
      .set(bearer(accessToken))
      .expect(200);

    expect(back.body.data).toEqual([
      {
        fromType: 'prep_sheet',
        fromId: sheetId,
        label: `백링크테스트 — ${stepName}`,
        applicationId: appId,
        stepId,
      },
    ]);

    // 시트 본문에서 멘션을 빼면 백링크도 사라진다
    await request(server())
      .patch(`/applications/${appId}/steps/${stepId}/note-sheets/${sheetId}`)
      .set(bearer(accessToken))
      .send({ content: PLAIN_DOC })
      .expect(200);

    const after = await request(server())
      .get(`/study-notes/${note.id}/backlinks`)
      .set(bearer(accessToken))
      .expect(200);
    expect(after.body.data).toEqual([]);
  });

  it('E10b) 🔴 시트를 삭제하면 그 시트가 내보낸 링크 행도 사라진다 (고아 0)', async () => {
    const { accessToken } = await signInAsUser(app);
    const note = await createNote(accessToken, { title: '참조될 노트' });
    const { appId, stepId, sheetId } = await createCardWithSheet(
      accessToken,
      '시트삭제테스트',
    );
    const sheetsUrl = `/applications/${appId}/steps/${stepId}/note-sheets`;

    await request(server())
      .patch(`${sheetsUrl}/${sheetId}`)
      .set(bearer(accessToken))
      .send({ content: docWithMentions(note.id) })
      .expect(200);

    const linkCount = async () => {
      const rows = await db().query<Array<{ n: number }>>(
        'SELECT count(*)::int AS n FROM study_note_links WHERE from_id = $1',
        [sheetId],
      );
      return rows[0].n;
    };
    expect(await linkCount()).toBe(1);

    // 마지막 1장은 못 지우니 한 장 더 만든 뒤 삭제
    await request(server())
      .post(sheetsUrl)
      .set(bearer(accessToken))
      .send({ name: '두 번째' })
      .expect(201);
    await request(server())
      .delete(`${sheetsUrl}/${sheetId}`)
      .set(bearer(accessToken))
      .expect(204);

    expect(await linkCount()).toBe(0);

    // 백링크 패널에서도 사라진다
    const back = await request(server())
      .get(`/study-notes/${note.id}/backlinks`)
      .set(bearer(accessToken))
      .expect(200);
    expect(back.body.data).toEqual([]);
  });

  // ── E11 ──

  it('E11) 자기 자신 멘션 → 무해 (500 없음)', async () => {
    const { accessToken } = await signInAsUser(app);
    const note = await createNote(accessToken, { title: '자기 참조' });

    await request(server())
      .patch(`/study-notes/${note.id}`)
      .set(bearer(accessToken))
      .send({ content: docWithMentions(note.id) })
      .expect(200);

    const back = await request(server())
      .get(`/study-notes/${note.id}/backlinks`)
      .set(bearer(accessToken))
      .expect(200);
    expect(back.body.data).toHaveLength(1);
    expect((back.body.data as Array<{ fromId: string }>)[0].fromId).toBe(
      note.id,
    );
  });

  it('E11b) 깨진 JSON·평문 본문도 저장된다 (멘션 0개로 취급)', async () => {
    const { accessToken } = await signInAsUser(app);
    const note = await createNote(accessToken);

    await request(server())
      .patch(`/study-notes/${note.id}`)
      .set(bearer(accessToken))
      .send({ content: '{"type":"doc",' })
      .expect(200);
  });

  // ── E12 ──

  it('E12) 허브 — 카드-스텝 그룹 (시트 수·최종 수정) · 본인 것만', async () => {
    const { accessToken } = await signInAsUser(app, { kakaoIdSuffix: 'hub' });
    const { appId, stepId, stepName } = await createCardWithSheet(
      accessToken,
      '허브테스트',
    );
    await request(server())
      .post(`/applications/${appId}/steps/${stepId}/note-sheets`)
      .set(bearer(accessToken))
      .send({ name: '2번째 시트' })
      .expect(201);

    const hub = await request(server())
      .get('/study-notes/hub/prep')
      .set(bearer(accessToken))
      .expect(200);

    const groups = hub.body.data as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      applicationId: appId,
      companyName: '허브테스트',
      stepId,
      stepName,
      sheetCount: 2,
    });
    expect(groups[0].lastUpdatedAt).toBeTruthy();

    // 다른 사용자에겐 안 보인다
    const { accessToken: other } = await signInAsUser(app, {
      kakaoIdSuffix: 'hub-other',
    });
    const otherHub = await request(server())
      .get('/study-notes/hub/prep')
      .set(bearer(other))
      .expect(200);
    expect(otherHub.body.data).toEqual([]);
  });

  it('E12b) 🔴 승격 전 유산 준비 노트도 허브에 나온다 (시트 수 1) · 빈 스텝·빈 문서 껍데기는 안 나온다', async () => {
    const { accessToken } = await signInAsUser(app, {
      kakaoIdSuffix: 'legacy',
    });

    const card = await request(server())
      .post('/applications')
      .set(bearer(accessToken))
      .send({ companyName: '유산테스트', templateId: 'general' })
      .expect(201);
    const body = card.body.data as {
      id: string;
      steps: Array<{ id: string; orderIndex: number; name: string }>;
    };
    const steps = [...body.steps].sort((a, b) => a.orderIndex - b.orderIndex);
    const [withSheet, legacyOnly, empty, emptyDoc] = steps;

    // (a) 시트가 있는 스텝 — 기존 갈래
    await request(server())
      .post(`/applications/${body.id}/steps/${withSheet.id}/note-sheets`)
      .set(bearer(accessToken))
      .send({ name: '시트 있음' })
      .expect(201);

    // (b) ADR-079 이전에 쓰고 그 뒤로 안 연 노트 — steps.notes 에만 있다
    await request(server())
      .patch(`/applications/${body.id}/steps/${legacyOnly.id}`)
      .set(bearer(accessToken))
      .send({ notes: PLAIN_DOC })
      .expect(200);

    // (c) 시트도 노트도 없는 스텝 — 준비 노트가 없으니 허브에도 없어야 한다

    // (d) 에디터만 열었다 나간 스텝 — 문자열은 비어있지 않지만 내용이 0이다.
    //     운영 dev DB 에 실제로 있는 모양이라(65건 중 1건) 유령 행이 되면 안 된다.
    await request(server())
      .patch(`/applications/${body.id}/steps/${emptyDoc.id}`)
      .set(bearer(accessToken))
      .send({ notes: '{"type":"doc","content":[{"type":"paragraph"}]}' })
      .expect(200);

    const hub = await request(server())
      .get('/study-notes/hub/prep')
      .set(bearer(accessToken))
      .expect(200);
    const groups = hub.body.data as Array<{
      stepId: string;
      stepName: string;
      sheetCount: number;
      lastUpdatedAt: string | null;
    }>;

    const byStep = new Map(groups.map((g) => [g.stepId, g]));

    // ① 유산 노트만 있는 스텝이 나온다 · 가상 시트 1장으로 표기
    expect(byStep.get(legacyOnly.id)).toMatchObject({
      stepName: legacyOnly.name,
      sheetCount: 1,
    });
    expect(byStep.get(legacyOnly.id)?.lastUpdatedAt).toBeTruthy();

    // ② 노트도 시트도 없는 스텝은 안 나온다
    expect(byStep.has(empty.id)).toBe(false);

    // ②' 🔴 빈 문서 껍데기만 있는 스텝도 안 나온다 (유령 행 금지)
    expect(byStep.has(emptyDoc.id)).toBe(false);

    // ③ 시트가 있는 스텝은 기존대로 (회귀)
    expect(byStep.get(withSheet.id)).toMatchObject({ sheetCount: 1 });

    expect(groups).toHaveLength(2);
  });

  it('E12c) 🔴 유산 노트가 승격되면 한 줄로만 뜬다 (두 갈래 중복 없음)', async () => {
    const { accessToken } = await signInAsUser(app, {
      kakaoIdSuffix: 'promote',
    });
    const card = await request(server())
      .post('/applications')
      .set(bearer(accessToken))
      .send({ companyName: '승격테스트', templateId: 'general' })
      .expect(201);
    const body = card.body.data as {
      id: string;
      steps: Array<{ id: string; orderIndex: number }>;
    };
    const step = [...body.steps].sort((a, b) => a.orderIndex - b.orderIndex)[0];

    await request(server())
      .patch(`/applications/${body.id}/steps/${step.id}`)
      .set(bearer(accessToken))
      .send({ notes: PLAIN_DOC })
      .expect(200);

    // 사용자가 스텝을 열면 프론트가 유산 노트를 첫 시트로 승격한다.
    // 이때 steps.notes 는 **그대로 남는다** (원본 보존) — 두 갈래가 겹칠 수 있는 유일한 지점.
    await request(server())
      .post(`/applications/${body.id}/steps/${step.id}/note-sheets`)
      .set(bearer(accessToken))
      .send({ name: '노트', content: PLAIN_DOC, ifEmpty: true })
      .expect(201);

    const hub = await request(server())
      .get('/study-notes/hub/prep')
      .set(bearer(accessToken))
      .expect(200);
    const groups = hub.body.data as Array<{ stepId: string }>;

    expect(groups.filter((g) => g.stepId === step.id)).toHaveLength(1);
  });

  // ── E13 ──

  it('E13) 🔴 last-write-wins — 연속 두 번 PATCH → 마지막 값', async () => {
    const { accessToken } = await signInAsUser(app);
    const note = await createNote(accessToken, { title: '두 탭' });

    await request(server())
      .patch(`/study-notes/${note.id}`)
      .set(bearer(accessToken))
      .send({ content: '{"tab":"A"}' })
      .expect(200);
    await request(server())
      .patch(`/study-notes/${note.id}`)
      .set(bearer(accessToken))
      .send({ content: '{"tab":"B"}' })
      .expect(200);

    const detail = await request(server())
      .get(`/study-notes/${note.id}`)
      .set(bearer(accessToken))
      .expect(200);
    expect((detail.body.data as NoteBody).content).toBe('{"tab":"B"}');
  });

  // ── E14 ──

  it('E14) 🔴 streak — 노트를 만든 당일(KST)이 heatmap 에 잡힌다', async () => {
    const { accessToken } = await signInAsUser(app, {
      kakaoIdSuffix: 'streak',
    });

    const before = await request(server())
      .get('/dashboard/streak')
      .set(bearer(accessToken))
      .expect(200);
    const beforeBody = before.body.data as {
      heatmap: { date: string; count: number }[];
    };
    /**
     * 🔴 오늘 날짜를 **서버 응답에서 뽑는다.** 로컬 시계로 만들면 CI 의 TZ 가
     * 바뀔 때마다 하루씩 어긋난다 (heatmap 의 마지막 칸이 곧 서버가 보는 KST 오늘).
     */
    const todayKst = beforeBody.heatmap[beforeBody.heatmap.length - 1].date;
    const baseline = beforeBody.heatmap[beforeBody.heatmap.length - 1].count;

    await createNote(accessToken, { title: '오늘 공부' });

    /**
     * 🔴 여기서 캐시를 **손으로 비우지 않는다.** 위의 첫 조회가 이미 5분 캐시를
     * 채웠으므로, 노트 저장 경로가 `invalidateCache` 를 부르지 않으면 아래 조회는
     * 옛 값을 그대로 돌려주고 이 테스트가 깨진다 — 배선 자체가 검증 대상이다.
     */
    const after = await request(server())
      .get('/dashboard/streak')
      .set(bearer(accessToken))
      .expect(200);
    const afterBody = after.body.data as {
      streak: { current: number; lastActivityDate: string | null };
      heatmap: { date: string; count: number }[];
    };
    const todayCell = afterBody.heatmap.find((h) => h.date === todayKst);

    expect(todayCell?.count).toBeGreaterThan(baseline);
    expect(afterBody.streak.current).toBeGreaterThanOrEqual(1);
    expect(afterBody.streak.lastActivityDate).toBe(todayKst);
  });

  // ── E15 ──

  it('E15) 🔴 탈퇴 CASCADE — user 삭제 시 노트·폴더·링크 전멸', async () => {
    const { accessToken, user } = await signInAsUser(app, {
      kakaoIdSuffix: 'delete',
    });
    const folderId = await createFolder(accessToken, '지워질 폴더');
    const target = await createNote(accessToken, { title: '대상', folderId });
    const source = await createNote(accessToken, { title: '출처' });
    await request(server())
      .patch(`/study-notes/${source.id}`)
      .set(bearer(accessToken))
      .send({ content: docWithMentions(target.id) })
      .expect(200);

    const counts = async () => {
      const rows = await db().query<
        Array<{ notes: number; folders: number; links: number }>
      >(
        `SELECT
           (SELECT count(*)::int FROM study_notes WHERE user_id = $1) AS notes,
           (SELECT count(*)::int FROM study_note_folders WHERE user_id = $1) AS folders,
           (SELECT count(*)::int FROM study_note_links WHERE from_id = $2) AS links`,
        [user.id, source.id],
      );
      return rows[0];
    };

    expect(await counts()).toEqual({ notes: 2, folders: 1, links: 1 });

    await request(server())
      .delete('/users/me')
      .set(bearer(accessToken))
      .expect(204);

    expect(await counts()).toEqual({ notes: 0, folders: 0, links: 0 });
  });

  // ── E16 ──

  it('E16) 정적 경로(folders·hub)가 :id 에 안 먹힌다', async () => {
    const { accessToken } = await signInAsUser(app);

    // uuid 가 아닌 'folders'·'hub' 가 :id 로 잡혔다면 ParseUUIDPipe 가 400 을 냈을 것이다
    await request(server())
      .get('/study-notes/folders')
      .set(bearer(accessToken))
      .expect(200);
    await request(server())
      .get('/study-notes/hub/prep')
      .set(bearer(accessToken))
      .expect(200);

    // 진짜 잘못된 id 는 400 (라우트가 살아 있다는 반대 증거)
    await request(server())
      .get('/study-notes/not-a-uuid')
      .set(bearer(accessToken))
      .expect(400);
  });
});
