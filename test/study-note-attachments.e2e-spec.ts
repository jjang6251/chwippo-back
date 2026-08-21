/**
 * **공부 노트 첨부** e2e — 실 DB + 실 라우트 (미디어 아크 PR-A).
 *
 * mock 단위 spec 이 원리적으로 볼 수 없는 것만 여기서 본다
 * (unique 제약·FK CASCADE·실 SQL 합산·실 트랜잭션·모듈 배선).
 *
 *  E1  등록 정상 → 201 `{ id, fileUrl }` · 행 1 · kind='image'
 *  E2  🔴 401 — 토큰 없이
 *  E3  🔴 IDOR — **남의 note_id** → 404 (403 이 아니다 · 행도 안 생긴다)
 *  E4  🔴 IDOR — 남의 파일 URL → 403
 *  E5  🔴 멱등 — 같은 fileUrl 두 번 → **같은 id · 행 1개** (unique(file_url) 실측)
 *  E6  🔴 cap — 한도−1B 통과 / 한도+1B 400 + 숫자 문구 (**실 SQL 합산**)
 *  E7  DTO — fileSizeBytes 0 · 10MB+1 · fileUrl 비URL → 400
 *  E8  🔴 reconcile — 참조 유지된 첨부는 살아 있다
 *  E9  🔴 reconcile — 본문에서 뺀 첨부는 정리되고 **R2 삭제까지** 간다
 *  E10 🔴 reconcile — 파싱 불가 본문 → **첨부 유지** (한 번의 깨진 저장에 이미지를 안 날린다)
 *  E11 reconcile — 본문 비움(content '') → 전부 정리
 *  E12 🔴 reconcile — 제목만 저장(content 미전달) → 첨부 무접촉
 *  E13 🔴 노트 삭제 → FK CASCADE 로 행 소멸 + R2 삭제 호출
 *  E14 🔴 **R2 삭제가 실패해도** 노트 삭제는 204 (외부 의존 — best-effort)
 *  E15 🔴 탈퇴 → 행 소멸 + 노트 첨부 URL 까지 R2 정리
 *  E16 🔴 GET /myinfo/storage-usage 에 노트 첨부가 잡힌다 (cap 과 같은 소스)
 *  E17 presigned — study-note/image × webp 통과 · pdf 거부 (실 라우트)
 *  E18 🔴 **race** — 등록 직후(유예 창 안) 미참조 저장이 신규 첨부를 못 지운다
 *  E19 🔴 유예 창을 지난 뒤의 저장에서는 그 고아가 정리된다
 *  E20 🔴 breakdown — myinfo 증빙과 노트 첨부가 **각각 제 칸**에 (실 SQL 두 소스)
 *  E21 🔴 breakdown — strokes_size_bytes 는 노트 쪽에 합산된다 (mock 이 못 보는 실 SQL)
 *
 * ⚠️ reconcile 계열 픽스처는 `ageOutAttachments` 로 **DB 시계 기준** 과거를 만든다.
 *    안 그러면 방금 등록한 행이 유예 창(60초) 안이라 정리 동작 자체가 안 일어난다.
 */
import { mockS3, mockGetSignedUrl } from './helpers/r2-mock';

const s3Mock = mockS3();
const presignerMock = mockGetSignedUrl();

jest.mock('@aws-sdk/client-s3', () => s3Mock);
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: presignerMock,
}));

// R2_PUBLIC_URL 이 빈 값이면 assertOwnFileUrl 가 silently skip → IDOR 테스트가 무의미해진다.
// CI 에선 미설정이라 진입 직전 강제 주입 (files.e2e-spec 와 같은 규약).
process.env.R2_PUBLIC_URL =
  process.env.R2_PUBLIC_URL || 'https://file-test.example.com';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { bearer, signInAsUser } from './helpers/auth';
import { createTestApp } from './helpers/bootstrap';
import { cleanAllTestUsers } from './helpers/db';

/** GET /myinfo/storage-usage 응답 — 프론트가 읽는 계약 그대로 */
interface StorageUsageBody {
  usedBytes: number;
  breakdown: { myinfoBytes: number; noteImageBytes: number };
}

interface AttachmentRow {
  id: string;
  user_id: string;
  note_id: string;
  kind: string;
  file_url: string;
  file_size_bytes: string;
  strokes_url: string | null;
}

describe('Study note attachments (e2e)', () => {
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
    s3Mock.send.mockResolvedValue({});
    s3Mock.DeleteObjectCommand.mockClear();
    presignerMock.mockClear();
  });

  afterEach(async () => {
    await cleanAllTestUsers(app);
  });

  const server = () => app.getHttpServer();
  const db = () => app.get(DataSource);

  /** 본인 prefix 파일 URL — assertOwnFileUrl 를 통과하는 모양 */
  const fileUrlFor = (userId: string, name: string) =>
    `${PUBLIC}/users/${userId}/study-note/image/${name}`;

  async function createNote(token: string): Promise<string> {
    const res = await request(server())
      .post('/study-notes')
      .set(bearer(token))
      .send({ title: '노트' })
      .expect(201);
    return (res.body.data as { id: string }).id;
  }

  async function registerAttachment(
    token: string,
    noteId: string,
    body: Record<string, unknown>,
    expectStatus = 201,
  ) {
    return request(server())
      .post(`/study-notes/${noteId}/attachments`)
      .set(bearer(token))
      .send(body)
      .expect(expectStatus);
  }

  const rowsOf = (noteId: string) =>
    db().query<AttachmentRow[]>(
      'SELECT * FROM note_attachments WHERE note_id = $1 ORDER BY created_at',
      [noteId],
    );

  /** 이미지 노드 하나짜리 tiptap doc */
  const docWithImages = (...attachmentIds: string[]) =>
    JSON.stringify({
      type: 'doc',
      content: attachmentIds.map((attachmentId) => ({
        type: 'image',
        attrs: { attachmentId, src: 'https://cdn/x.jpg' },
      })),
    });

  /** DeleteObjectCommand 로 넘어간 Key 목록 */
  const deletedKeys = () =>
    s3Mock.DeleteObjectCommand.mock.calls.map(
      ([args]) => (args as { Key: string }).Key,
    );

  // ── 등록 ──────────────────────────────────────────────

  it('E1) 등록 정상 → 201 { id, fileUrl } · 행 1 · kind=image', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const noteId = await createNote(accessToken);
    const fileUrl = fileUrlFor(user.id, 'a.jpg');

    const res = await registerAttachment(accessToken, noteId, {
      fileUrl,
      fileSizeBytes: 2048,
    });

    expect(res.body.data).toEqual({
      id: expect.any(String) as string,
      fileUrl,
    });

    const rows = await rowsOf(noteId);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('image');
    expect(rows[0].user_id).toBe(user.id);
    expect(Number(rows[0].file_size_bytes)).toBe(2048);
    expect(rows[0].strokes_url).toBeNull();
  });

  it('E2) 🔴 토큰 없이 → 401', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const noteId = await createNote(accessToken);

    await request(server())
      .post(`/study-notes/${noteId}/attachments`)
      .send({ fileUrl: fileUrlFor(user.id, 'a.jpg'), fileSizeBytes: 100 })
      .expect(401);
  });

  it('E3) 🔴 IDOR — 남의 note_id 로 등록 → 404 · 행도 안 생긴다', async () => {
    const owner = await signInAsUser(app);
    const attacker = await signInAsUser(app);
    const noteId = await createNote(owner.accessToken);

    await registerAttachment(
      attacker.accessToken,
      noteId,
      {
        fileUrl: fileUrlFor(attacker.user.id, 'evil.jpg'),
        fileSizeBytes: 100,
      },
      404,
    );

    expect(await rowsOf(noteId)).toHaveLength(0);
  });

  it('E4) 🔴 IDOR — 남의 파일 URL 을 내 노트에 붙이기 → 403', async () => {
    const victim = await signInAsUser(app);
    const attacker = await signInAsUser(app);
    const noteId = await createNote(attacker.accessToken);

    await registerAttachment(
      attacker.accessToken,
      noteId,
      { fileUrl: fileUrlFor(victim.user.id, 'secret.jpg'), fileSizeBytes: 100 },
      403,
    );

    expect(await rowsOf(noteId)).toHaveLength(0);
  });

  it('E5) 🔴 멱등 — 같은 fileUrl 두 번 → 같은 id · 행 1개 (unique 실측)', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const noteId = await createNote(accessToken);
    const body = {
      fileUrl: fileUrlFor(user.id, 'same.jpg'),
      fileSizeBytes: 500,
    };

    const first = await registerAttachment(accessToken, noteId, body);
    const second = await registerAttachment(accessToken, noteId, body);

    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await rowsOf(noteId)).toHaveLength(1);
  });

  it('E5) 멱등 — 두 번째 요청은 용량을 다시 청구하지 않는다', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const noteId = await createNote(accessToken);
    const body = {
      fileUrl: fileUrlFor(user.id, 'same.jpg'),
      fileSizeBytes: 4096,
    };

    await registerAttachment(accessToken, noteId, body);
    await registerAttachment(accessToken, noteId, body);

    const usage = await request(server())
      .get('/myinfo/storage-usage')
      .set(bearer(accessToken))
      .expect(200);
    expect((usage.body.data as { usedBytes: number }).usedBytes).toBe(4096);
  });

  it('E6) 🔴 cap 경계 — 한도−1B 는 통과, 한도+1B 는 400 + 숫자 문구', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const noteId = await createNote(accessToken);

    // 실 SQL 합산을 태우기 위해 기존 사용량을 행으로 심는다 (99MB)
    const limit = 100 * 1024 * 1024;
    const seeded = 99 * 1024 * 1024;
    await db().query(
      `INSERT INTO note_attachments (user_id, note_id, kind, file_url, file_size_bytes)
       VALUES ($1, $2, 'image', $3, $4)`,
      [user.id, noteId, fileUrlFor(user.id, 'seed.jpg'), seeded],
    );

    // 남은 여유는 정확히 1MB — 1B 모자란 요청은 통과
    await registerAttachment(accessToken, noteId, {
      fileUrl: fileUrlFor(user.id, 'fit.jpg'),
      fileSizeBytes: limit - seeded - 1,
    });

    // 이제 딱 1B 만 남았다 — 2B 요청은 초과
    const rejected = await registerAttachment(
      accessToken,
      noteId,
      { fileUrl: fileUrlFor(user.id, 'over.jpg'), fileSizeBytes: 2 },
      400,
    );
    expect(rejected.body.message).toMatch(/저장 공간이 부족합니다/);
    expect(rejected.body.message).toMatch(/100MB/);

    // 거부된 요청의 행은 남지 않는다
    const urls = (await rowsOf(noteId)).map((r) => r.file_url);
    expect(urls).not.toContain(fileUrlFor(user.id, 'over.jpg'));
  });

  it.each([
    ['fileSizeBytes 0', { fileSizeBytes: 0 }],
    ['fileSizeBytes 10MB+1', { fileSizeBytes: 10 * 1024 * 1024 + 1 }],
    ['fileSizeBytes 음수', { fileSizeBytes: -1 }],
    ['fileUrl 비 URL', { fileUrl: 'not-a-url' }],
    ['fileUrl 누락', { fileUrl: undefined }],
  ])('E7) DTO — %s → 400', async (_label, override) => {
    const { accessToken, user } = await signInAsUser(app);
    const noteId = await createNote(accessToken);

    await registerAttachment(
      accessToken,
      noteId,
      {
        fileUrl: fileUrlFor(user.id, 'a.jpg'),
        fileSizeBytes: 100,
        ...override,
      },
      400,
    );
  });

  // ── 저장 reconcile ────────────────────────────────────

  /**
   * 유예 창(등록 후 60초) 밖으로 밀어낸다 — **DB 시계로** 과거를 만든다.
   * 방금 등록한 행은 reconcile 이 일부러 건드리지 않으므로(race 방어), 정리 동작을
   * 보려면 픽스처가 "확정될 시간이 지난 첨부" 여야 한다.
   */
  const ageOutAttachments = (noteId: string) =>
    db().query(
      `UPDATE note_attachments SET created_at = now() - interval '10 minutes' WHERE note_id = $1`,
      [noteId],
    );

  async function seedTwoAttachments(token: string, userId: string) {
    const noteId = await createNote(token);
    const keep = await registerAttachment(token, noteId, {
      fileUrl: fileUrlFor(userId, 'keep.jpg'),
      fileSizeBytes: 100,
    });
    const drop = await registerAttachment(token, noteId, {
      fileUrl: fileUrlFor(userId, 'drop.jpg'),
      fileSizeBytes: 100,
    });
    await ageOutAttachments(noteId);
    return {
      noteId,
      keepId: (keep.body.data as { id: string }).id,
      dropId: (drop.body.data as { id: string }).id,
    };
  }

  it('E8·E9) 🔴 reconcile — 참조는 살고, 빠진 첨부는 행·R2 둘 다 정리된다', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const { noteId, keepId } = await seedTwoAttachments(accessToken, user.id);
    s3Mock.DeleteObjectCommand.mockClear();

    await request(server())
      .patch(`/study-notes/${noteId}`)
      .set(bearer(accessToken))
      .send({ content: docWithImages(keepId) })
      .expect(200);

    const rows = await rowsOf(noteId);
    expect(rows.map((r) => r.id)).toEqual([keepId]);
    expect(deletedKeys()).toEqual([
      `users/${user.id}/study-note/image/drop.jpg`,
    ]);
  });

  it('E10) 🔴 reconcile — 파싱 불가 본문 → 첨부를 하나도 안 지운다', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const { noteId } = await seedTwoAttachments(accessToken, user.id);
    s3Mock.DeleteObjectCommand.mockClear();

    await request(server())
      .patch(`/study-notes/${noteId}`)
      .set(bearer(accessToken))
      .send({ content: '{깨진 JSON' })
      .expect(200);

    expect(await rowsOf(noteId)).toHaveLength(2);
    expect(deletedKeys()).toEqual([]);
  });

  it('E11) reconcile — 본문 비움 → 전부 정리', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const { noteId } = await seedTwoAttachments(accessToken, user.id);

    await request(server())
      .patch(`/study-notes/${noteId}`)
      .set(bearer(accessToken))
      .send({ content: '' })
      .expect(200);

    expect(await rowsOf(noteId)).toHaveLength(0);
  });

  it('E12) 🔴 reconcile — 제목만 저장(content 미전달) → 첨부 무접촉', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const { noteId } = await seedTwoAttachments(accessToken, user.id);
    s3Mock.DeleteObjectCommand.mockClear();

    await request(server())
      .patch(`/study-notes/${noteId}`)
      .set(bearer(accessToken))
      .send({ title: '제목만 바꿈' })
      .expect(200);

    expect(await rowsOf(noteId)).toHaveLength(2);
    expect(deletedKeys()).toEqual([]);
  });

  it('E18) 🔴 race — 등록 직후(유예 창 안) 미참조 저장이 신규 첨부를 못 지운다', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const noteId = await createNote(accessToken);

    // 프론트 흐름 재현: placeholder 가 자동저장을 깨워, attachmentId 없는 본문이
    // 등록 직후에 저장된다 (ageOut 을 **일부러 안 한다** — 방금 등록된 상태 그대로)
    const registered = await registerAttachment(accessToken, noteId, {
      fileUrl: fileUrlFor(user.id, 'pasting.jpg'),
      fileSizeBytes: 100,
    });
    s3Mock.DeleteObjectCommand.mockClear();

    await request(server())
      .patch(`/study-notes/${noteId}`)
      .set(bearer(accessToken))
      .send({ content: docWithImages() }) // 아직 노드에 id 가 없다
      .expect(200);

    const rows = await rowsOf(noteId);
    expect(rows.map((r) => r.id)).toEqual([
      (registered.body.data as { id: string }).id,
    ]);
    expect(deletedKeys()).toEqual([]);

    // 다음 저장(그때는 본문에 id 가 있다)에서도 그대로 살아 있다
    await request(server())
      .patch(`/study-notes/${noteId}`)
      .set(bearer(accessToken))
      .send({
        content: docWithImages((registered.body.data as { id: string }).id),
      })
      .expect(200);
    expect(await rowsOf(noteId)).toHaveLength(1);
  });

  it('E19) 🔴 유예 창을 지난 뒤의 저장에서는 그 고아가 정리된다', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const noteId = await createNote(accessToken);
    await registerAttachment(accessToken, noteId, {
      fileUrl: fileUrlFor(user.id, 'never-confirmed.jpg'),
      fileSizeBytes: 100,
    });

    // 확정되지 못한 채 60초가 지났다 (DB 시계로 과거를 만든다)
    await ageOutAttachments(noteId);
    s3Mock.DeleteObjectCommand.mockClear();

    await request(server())
      .patch(`/study-notes/${noteId}`)
      .set(bearer(accessToken))
      .send({ content: docWithImages() })
      .expect(200);

    expect(await rowsOf(noteId)).toHaveLength(0);
    expect(deletedKeys()).toEqual([
      `users/${user.id}/study-note/image/never-confirmed.jpg`,
    ]);
  });

  // ── 노트 삭제 · 탈퇴 ──────────────────────────────────

  it('E13) 🔴 노트 삭제 → FK CASCADE 로 행 소멸 + R2 삭제 호출', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const { noteId } = await seedTwoAttachments(accessToken, user.id);
    s3Mock.DeleteObjectCommand.mockClear();

    await request(server())
      .delete(`/study-notes/${noteId}`)
      .set(bearer(accessToken))
      .expect(204);

    expect(await rowsOf(noteId)).toHaveLength(0);
    expect(deletedKeys().sort()).toEqual([
      `users/${user.id}/study-note/image/drop.jpg`,
      `users/${user.id}/study-note/image/keep.jpg`,
    ]);
  });

  it('E14) 🔴 R2 삭제가 실패해도 노트 삭제는 204 (외부 의존 — best-effort)', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const { noteId } = await seedTwoAttachments(accessToken, user.id);
    s3Mock.send.mockRejectedValue(new Error('R2 503 (외부 장애)'));

    await request(server())
      .delete(`/study-notes/${noteId}`)
      .set(bearer(accessToken))
      .expect(204);

    // DB 는 정상 정리 — 고아 R2 객체만 남는다 (기존 best-effort 정책 그대로)
    expect(await rowsOf(noteId)).toHaveLength(0);
  });

  it('E15) 🔴 탈퇴 → 행 소멸 + 노트 첨부 URL 까지 R2 정리', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const { noteId } = await seedTwoAttachments(accessToken, user.id);
    s3Mock.DeleteObjectCommand.mockClear();

    await request(server())
      .delete('/users/me')
      .set(bearer(accessToken))
      .expect(204);

    expect(await rowsOf(noteId)).toHaveLength(0);
    expect(deletedKeys().sort()).toEqual([
      `users/${user.id}/study-note/image/drop.jpg`,
      `users/${user.id}/study-note/image/keep.jpg`,
    ]);
  });

  // ── 용량 통계 · presigned ─────────────────────────────

  it('E16) 🔴 GET /myinfo/storage-usage 에 노트 첨부가 잡힌다', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const noteId = await createNote(accessToken);

    const before = await request(server())
      .get('/myinfo/storage-usage')
      .set(bearer(accessToken))
      .expect(200);
    expect((before.body.data as { usedBytes: number }).usedBytes).toBe(0);

    await registerAttachment(accessToken, noteId, {
      fileUrl: fileUrlFor(user.id, 'a.jpg'),
      fileSizeBytes: 3 * 1024 * 1024,
    });

    const after = await request(server())
      .get('/myinfo/storage-usage')
      .set(bearer(accessToken))
      .expect(200);
    expect((after.body.data as { usedBytes: number }).usedBytes).toBe(
      3 * 1024 * 1024,
    );
  });

  it('E20) 🔴 breakdown — myinfo 증빙과 노트 첨부가 각각 제 칸에 (실 SQL)', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const noteId = await createNote(accessToken);

    // myinfo 증빙 1건 — 노트와 다른 소스
    await db().query(
      `INSERT INTO myinfo_certs (user_id, name, file_url, file_size_bytes)
       VALUES ($1, $2, $3, $4)`,
      [user.id, '정보처리기사', `${PUBLIC}/users/${user.id}/cert/a.pdf`, 4096],
    );
    await registerAttachment(accessToken, noteId, {
      fileUrl: fileUrlFor(user.id, 'note.jpg'),
      fileSizeBytes: 1024,
    });

    const res = await request(server())
      .get('/myinfo/storage-usage')
      .set(bearer(accessToken))
      .expect(200);

    const usage = res.body.data as StorageUsageBody;
    expect(usage.breakdown).toEqual({
      myinfoBytes: 4096,
      noteImageBytes: 1024,
    });
    expect(usage.usedBytes).toBe(
      usage.breakdown.myinfoBytes + usage.breakdown.noteImageBytes,
    );
  });

  it('E21) 🔴 breakdown — strokes_size_bytes 는 노트 쪽에 합산된다', async () => {
    const { accessToken, user } = await signInAsUser(app);
    const noteId = await createNote(accessToken);

    // 필기 stroke 는 아직 API 경로가 없다 (PR-C 보류) — 실 컬럼을 직접 심어 합산을 본다
    await db().query(
      `INSERT INTO note_attachments
         (user_id, note_id, kind, file_url, file_size_bytes, strokes_url, strokes_size_bytes)
       VALUES ($1, $2, 'image', $3, $4, $5, $6)`,
      [
        user.id,
        noteId,
        fileUrlFor(user.id, 'drawn.jpg'),
        2048,
        `${PUBLIC}/users/${user.id}/study-note/image/drawn.json`,
        512,
      ],
    );

    const res = await request(server())
      .get('/myinfo/storage-usage')
      .set(bearer(accessToken))
      .expect(200);

    const usage = res.body.data as StorageUsageBody;
    expect(usage.breakdown).toEqual({
      myinfoBytes: 0,
      noteImageBytes: 2048 + 512,
    });
    expect(usage.usedBytes).toBe(2560);
  });

  it('E17) presigned — study-note/image × webp 통과 · pdf 거부', async () => {
    const { accessToken, user } = await signInAsUser(app);

    const ok = await request(server())
      .post('/files/presigned-url')
      .set(bearer(accessToken))
      .send({
        scope: 'study-note/image',
        contentType: 'image/webp',
        fileSize: 1024,
      })
      .expect(201);
    expect(ok.body.data.fileUrl).toMatch(
      new RegExp(`^${PUBLIC}/users/${user.id}/study-note/image/.+\\.webp$`),
    );

    await request(server())
      .post('/files/presigned-url')
      .set(bearer(accessToken))
      .send({
        scope: 'study-note/image',
        contentType: 'application/pdf',
        fileSize: 1024,
      })
      .expect(400);
  });
});
