import { EntityManager } from 'typeorm';
import {
  MENTION_NODE_TYPE,
  extractMentionNoteIds,
  syncStudyNoteLinks,
} from './mention-links';
import { StudyNoteLink } from './study-note-link.entity';
import { StudyNote } from './study-note.entity';

/**
 * 멘션 추출 + 링크 재계산 spec.
 *
 * ────────────────────────────────────────────────────────────────────────
 * 시나리오를 **먼저 나열하고** 코드를 확인했다. 이 함수의 입력은 사용자가 붙여넣은
 * 것까지 들어오는 자유 텍스트라, "정상 doc" 보다 **비정상 입력**이 더 중요하다.
 *
 * ## extractMentionNoteIds — 정상
 *  X1  멘션 1개 → id 1개
 *  X2  멘션 여러 개 → 전부 (입력 순서)
 *  X3  같은 노트 두 번 멘션 → **1개** (중복 제거 = 백링크 목록에 같은 출처가 두 번 안 뜬다)
 *  X4  표 안 셀 안 문단처럼 **깊이 중첩된** 멘션도 찾는다
 *  X5  marks·attrs 같은 다른 키에 섞여 있어도 찾는다
 *
 * ## extractMentionNoteIds — 비정상 (전부 **throw 없이 []**)
 *  X6  null · 빈 문자열
 *  X7  🔴 깨진 JSON — 저장 자체가 실패하면 안 된다
 *  X8  JSON 이지만 문서가 아님 (숫자·문자열·배열 최상위)
 *  X9  멘션 노드가 하나도 없는 정상 doc
 *  X10 `attrs` 없음 · `noteId` 없음 · `noteId` 가 문자열이 아님
 *  X11 🔴 `noteId` 가 uuid 형식이 아님 → **버린다** (그대로 쿼리 인자로 나가면 Postgres 가 500)
 *  X12 type 이름이 비슷하지만 다른 노드 → 무시
 *  X13 🔴 아주 깊은 중첩(10,000단) → 스택 안 터진다 (재귀가 아니라 반복문인 근거)
 *
 * ## syncStudyNoteLinks
 *  S1  멘션 0 → from 단위 delete 만 하고 insert 는 **안 한다**
 *  S2  멘션 2 (둘 다 내 노트) → delete 후 2행 insert
 *  S3  🔴 남의 노트 id 가 섞임 → 그 id 만 빠진다 (본문은 클라이언트가 보낸 값 = 쓰기 IDOR 차단)
 *  S4  전부 남의 노트 → delete 만, insert 미호출
 *  S5  from_type 이 인자 그대로 실린다 (study / prep_sheet)
 *  S6  delete 조건은 **from_id + from_type** 조합 (같은 id 의 다른 소스를 안 건드린다)
 *  S7  🔴 delete 가 실패하면 그대로 던진다 (삼키면 호출자 트랜잭션이 롤백을 못 한다)
 *  S8  🔴 insert 가 실패하면 그대로 던진다
 * ────────────────────────────────────────────────────────────────────────
 */

const NOTE_A = '11111111-1111-4111-8111-111111111111';
const NOTE_B = '22222222-2222-4222-8222-222222222222';
const OTHERS = '33333333-3333-4333-8333-333333333333';
const FROM_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';

/** tiptap 멘션 노드 한 개 */
const mention = (noteId: unknown) => ({
  type: MENTION_NODE_TYPE,
  attrs: { noteId, label: '스냅샷 제목' },
});

/** 문단 하나짜리 doc — children 을 그대로 실어 준다 */
const doc = (...content: unknown[]) =>
  JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content }] });

describe('extractMentionNoteIds', () => {
  it('X1) 멘션 1개 → id 1개', () => {
    expect(extractMentionNoteIds(doc(mention(NOTE_A)))).toEqual([NOTE_A]);
  });

  it('X2) 멘션 여러 개 → 전부 · **문서 순서 그대로** (INSERT·테스트가 결정적)', () => {
    const ids = extractMentionNoteIds(
      doc(mention(NOTE_B), { type: 'text', text: ' 참고 ' }, mention(NOTE_A)),
    );
    expect(ids).toEqual([NOTE_B, NOTE_A]);
  });

  it('X3) 같은 노트 두 번 멘션 → 1개 (중복 제거)', () => {
    expect(
      extractMentionNoteIds(doc(mention(NOTE_A), mention(NOTE_A))),
    ).toEqual([NOTE_A]);
  });

  it('X4) 표 안 셀 안 문단처럼 깊이 중첩된 멘션도 찾는다', () => {
    const content = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [
                    { type: 'paragraph', content: [mention(NOTE_A)] },
                    {
                      type: 'details',
                      content: [
                        { type: 'paragraph', content: [mention(NOTE_B)] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(extractMentionNoteIds(content)).toEqual([NOTE_A, NOTE_B]);
  });

  it('X5) marks 같은 다른 키 밑에 있어도 찾는다', () => {
    const content = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          marks: [{ type: 'highlight', attrs: { color: 'yellow' } }],
          content: [mention(NOTE_A)],
        },
      ],
    });

    expect(extractMentionNoteIds(content)).toEqual([NOTE_A]);
  });

  it('X6) null · 빈 문자열 → []', () => {
    expect(extractMentionNoteIds(null)).toEqual([]);
    expect(extractMentionNoteIds('')).toEqual([]);
  });

  it('X7) 🔴 깨진 JSON → [] (throw 하지 않는다 — 저장이 막히면 안 된다)', () => {
    expect(() => extractMentionNoteIds('{"type":"doc",')).not.toThrow();
    expect(extractMentionNoteIds('{"type":"doc",')).toEqual([]);
    expect(extractMentionNoteIds('그냥 평문입니다')).toEqual([]);
  });

  it('X8) JSON 이지만 문서가 아님 (숫자·문자열·배열 최상위) → []', () => {
    expect(extractMentionNoteIds('123')).toEqual([]);
    expect(extractMentionNoteIds('"문자열"')).toEqual([]);
    expect(extractMentionNoteIds('null')).toEqual([]);
    expect(extractMentionNoteIds(JSON.stringify([mention(NOTE_A)]))).toEqual([
      NOTE_A,
    ]);
  });

  it('X9) 멘션 없는 정상 doc → []', () => {
    expect(
      extractMentionNoteIds(doc({ type: 'text', text: '공부 정리' })),
    ).toEqual([]);
  });

  it('X10) attrs 없음 · noteId 없음 · noteId 가 문자열이 아님 → 무시', () => {
    expect(extractMentionNoteIds(doc({ type: MENTION_NODE_TYPE }))).toEqual([]);
    expect(
      extractMentionNoteIds(doc({ type: MENTION_NODE_TYPE, attrs: {} })),
    ).toEqual([]);
    expect(extractMentionNoteIds(doc(mention(12345)))).toEqual([]);
    expect(extractMentionNoteIds(doc(mention(null)))).toEqual([]);
  });

  it('X11) 🔴 uuid 형식이 아닌 noteId 는 버린다 (쿼리 인자 오염 차단)', () => {
    expect(extractMentionNoteIds(doc(mention('not-a-uuid')))).toEqual([]);
    expect(
      extractMentionNoteIds(doc(mention("1' OR '1'='1"), mention(NOTE_A))),
    ).toEqual([NOTE_A]);
  });

  it('X12) 이름이 비슷한 다른 노드 → 무시', () => {
    expect(extractMentionNoteIds(doc({ type: 'mention', attrs: {} }))).toEqual(
      [],
    );
    expect(
      extractMentionNoteIds(
        doc({ type: 'studyNoteMentionX', attrs: { noteId: NOTE_A } }),
      ),
    ).toEqual([]);
  });

  it('X13) 🔴 10,000단 중첩 → 스택이 안 터진다 (반복문 순회 근거)', () => {
    // 🔴 문자열을 손으로 짓는다 — `JSON.stringify` 로 이 깊이를 만들면 **테스트 쪽**이
    // 먼저 스택을 터뜨린다 (V8 의 stringify 는 재귀, parse 는 아니다).
    // 실제 입력도 클라이언트가 보낸 **문자열**이라 이쪽이 진짜 경로다.
    const depth = 10_000;
    const deep =
      '{"type":"doc","content":[' +
      '{"type":"paragraph","content":['.repeat(depth) +
      `{"type":"${MENTION_NODE_TYPE}","attrs":{"noteId":"${NOTE_A}"}}` +
      ']}'.repeat(depth) +
      ']}';

    expect(() => extractMentionNoteIds(deep)).not.toThrow();
    expect(extractMentionNoteIds(deep)).toEqual([NOTE_A]);
  });
});

describe('syncStudyNoteLinks', () => {
  let linkRepo: { delete: jest.Mock; insert: jest.Mock };
  let noteRepo: { find: jest.Mock };
  let requested: unknown[];
  let em: EntityManager;

  beforeEach(() => {
    linkRepo = { delete: jest.fn(), insert: jest.fn() };
    noteRepo = { find: jest.fn().mockResolvedValue([]) };
    requested = [];

    em = {
      getRepository: (entity: unknown) => {
        requested.push(entity);
        return entity === StudyNoteLink ? linkRepo : noteRepo;
      },
    } as unknown as EntityManager;
  });

  /** "내 노트" 인 id 목록을 돌려주도록 세팅 */
  const ownedNotes = (...ids: string[]) =>
    noteRepo.find.mockResolvedValue(ids.map((id) => ({ id })));

  it('S1) 멘션 0 → delete 만, insert 미호출', async () => {
    await syncStudyNoteLinks(
      em,
      { fromId: FROM_ID, fromType: 'study', userId: USER_ID },
      doc({ type: 'text', text: '멘션 없음' }),
    );

    expect(linkRepo.delete).toHaveBeenCalledTimes(1);
    expect(linkRepo.insert).not.toHaveBeenCalled();
    // 멘션이 없으면 노트 소유권 조회도 안 한다 (쓸데없는 왕복 없음)
    expect(noteRepo.find).not.toHaveBeenCalled();
  });

  it('S2) 멘션 2 (둘 다 내 노트) → delete 후 2행 insert', async () => {
    ownedNotes(NOTE_A, NOTE_B);

    await syncStudyNoteLinks(
      em,
      { fromId: FROM_ID, fromType: 'study', userId: USER_ID },
      doc(mention(NOTE_A), mention(NOTE_B)),
    );

    expect(linkRepo.insert).toHaveBeenCalledWith([
      { fromId: FROM_ID, fromType: 'study', toNoteId: NOTE_A },
      { fromId: FROM_ID, fromType: 'study', toNoteId: NOTE_B },
    ]);
  });

  it('S3) 🔴 남의 노트 id 가 섞이면 그 id 만 빠진다 (쓰기 IDOR 차단)', async () => {
    // 소유권 조회는 내 것만 돌려준다
    ownedNotes(NOTE_A);

    await syncStudyNoteLinks(
      em,
      { fromId: FROM_ID, fromType: 'study', userId: USER_ID },
      doc(mention(NOTE_A), mention(OTHERS)),
    );

    // 조회 자체가 user_id 로 잠겨 있다
    const findArg = noteRepo.find.mock.calls[0][0] as {
      where: { userId: string };
    };
    expect(findArg.where.userId).toBe(USER_ID);

    expect(linkRepo.insert).toHaveBeenCalledWith([
      { fromId: FROM_ID, fromType: 'study', toNoteId: NOTE_A },
    ]);
  });

  it('S4) 전부 남의 노트 → delete 만, insert 미호출', async () => {
    ownedNotes();

    await syncStudyNoteLinks(
      em,
      { fromId: FROM_ID, fromType: 'study', userId: USER_ID },
      doc(mention(OTHERS)),
    );

    expect(linkRepo.delete).toHaveBeenCalledTimes(1);
    expect(linkRepo.insert).not.toHaveBeenCalled();
  });

  it('S5) from_type 이 인자 그대로 실린다 (prep_sheet)', async () => {
    ownedNotes(NOTE_A);

    await syncStudyNoteLinks(
      em,
      { fromId: FROM_ID, fromType: 'prep_sheet', userId: USER_ID },
      doc(mention(NOTE_A)),
    );

    expect(linkRepo.insert).toHaveBeenCalledWith([
      { fromId: FROM_ID, fromType: 'prep_sheet', toNoteId: NOTE_A },
    ]);
    expect(requested).toContain(StudyNoteLink);
    expect(requested).toContain(StudyNote);
  });

  it('S6) delete 조건은 from_id + from_type 조합', async () => {
    await syncStudyNoteLinks(
      em,
      { fromId: FROM_ID, fromType: 'prep_sheet', userId: USER_ID },
      null,
    );

    expect(linkRepo.delete).toHaveBeenCalledWith({
      fromId: FROM_ID,
      fromType: 'prep_sheet',
    });
  });

  it('S7) 🔴 delete 실패는 삼키지 않는다 (호출자 트랜잭션이 롤백해야 한다)', async () => {
    linkRepo.delete.mockRejectedValue(new Error('DB 끊김'));

    await expect(
      syncStudyNoteLinks(
        em,
        { fromId: FROM_ID, fromType: 'study', userId: USER_ID },
        doc(mention(NOTE_A)),
      ),
    ).rejects.toThrow('DB 끊김');
  });

  it('S8) 🔴 insert 실패도 삼키지 않는다', async () => {
    ownedNotes(NOTE_A);
    linkRepo.insert.mockRejectedValue(new Error('제약 위반'));

    await expect(
      syncStudyNoteLinks(
        em,
        { fromId: FROM_ID, fromType: 'study', userId: USER_ID },
        doc(mention(NOTE_A)),
      ),
    ).rejects.toThrow('제약 위반');
  });
});
