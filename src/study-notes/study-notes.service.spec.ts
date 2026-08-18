import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { DataSource, EntityManager, FindOperator, Repository } from 'typeorm';
import { StreakService } from '../dashboard/streak.service';
import { MENTION_NODE_TYPE } from './mention-links';
import { StudyNoteFolder } from './study-note-folder.entity';
import { StudyNoteLink } from './study-note-link.entity';
import { StudyNote } from './study-note.entity';
import {
  MAX_NOTES_PER_USER,
  NOTE_TITLE_MAX_CHARS,
  StudyNotesService,
} from './study-notes.service';

/**
 * **공부 노트** 서비스 spec.
 *
 * ────────────────────────────────────────────────────────────────────────
 * 아래 시나리오를 **먼저 나열하고** 코드를 확인했다. 통과시키려고 짠 게 아니라
 * 깨뜨리려고 짠 목록이다 (정상·경계·권한·트랜잭션·링크 재계산·동시성 순회).
 *
 * ## list / get
 *  L1  snake_case → camelCase 매핑 (`backlinkCount` 포함)
 *  L2  🔴 **본문 미포함** · user_id 스코프 · 최근 수정순
 *  L3  🔴 백링크 수는 **출처가 내 것인** 링크만 (백링크 패널과 같은 기준 — 배지와 패널이 어긋나면 안 된다)
 *  L4  링크 없는 노트도 목록에 남는다 (LEFT JOIN · count 0)
 *  G1  정상 (본문 포함)
 *  G2  없는 노트 → 404
 *  G3  🔴 남의 노트 → 404 (조회 자체가 user_id 로 잠긴다 — 존재 여부 누출 없음)
 *
 * ## create
 *  C1  정상 — 제목 trim · content null · folder null
 *  C2  🔴 제목 미전달 → **''** (노션식 즉시 생성 — 빈 제목이 정상 값)
 *  C3  제목 공백만 → ''
 *  C4  제목 100자 경계 → OK
 *  C5  제목 101자 → 400 · **트랜잭션 자체를 안 연다**
 *  C6  앞뒤 공백 붙은 102자 → trim 후 100 → OK
 *  C7  content 빈 문자열 → null
 *  C8  캡 경계 499개 → OK
 *  C9  🔴 캡 500개 → 400 · 문구에 숫자·현재 개수 · save 미호출
 *  C10 folderId 지정(내 폴더) → OK
 *  C11 🔴 남의 폴더·없는 폴더 → 400 · save 미호출
 *  C12 content 에 멘션 → 링크 insert
 *  C13 content 없음 → **링크 repo 를 아예 안 부른다** (왕복 절약)
 *  C14 🔴 링크 insert 실패 → **노트까지 롤백** (부분 저장 없음)
 *
 * ## update
 *  U1  제목 변경 (+trim)
 *  U2  content 변경 → 링크 재계산
 *  U3  content 빈 문자열 → null · 링크 전부 제거
 *  U4  🔴 content 미전달 → **링크 재계산 안 함** (이름만 바꿔도 백링크가 흔들리면 안 된다)
 *  U5  folderId null 명시 → 미분류
 *  U6  🔴 folderId 미전달 → 폴더 **불변** (자동저장이 본문만 보내는데 폴더가 풀리면 안 된다)
 *  U7  제목 101자 → 400 · 트랜잭션 미개시
 *  U8  🔴 없는 노트·남의 노트 → 404
 *  U9  남의 폴더로 이동 → 400 · save 미호출
 *  U10 🔴 링크 재계산 실패 → **저장 롤백**
 *  U11 🔴 **last-write-wins** — 연속 두 번 저장하면 마지막 값이 남는다
 *  U12 멘션 제거 → 링크도 사라진다 (delete 만, insert 없음)
 *  U13 🔴 자기 자신 멘션 → 무해 (예외 없음 · 링크 1행)
 *
 * ## remove
 *  D1  정상 — 노트 삭제 + **내보낸 링크** 삭제 (from 쪽엔 FK 가 없어 CASCADE 가 안 닿는다)
 *  D2  없는 노트·남의 노트 → 404 · 링크도 안 지운다
 *  D3  🔴 삭제와 링크 정리가 **한 트랜잭션** (실패 시 둘 다 롤백)
 *
 * ## backlinks
 *  B1  🔴 남의 노트 → 404 · **쿼리를 던지지도 않는다**
 *  B2  study 소스 → label = 제목 · 딥링크 id 는 null
 *  B3  prep_sheet 소스 → label = "회사명 — 스텝명" · applicationId·stepId 실림
 *  B4  🔴 SQL 이 **두 소스 모두** user_id 로 잠겨 있다
 *  B5  링크 없음 → []
 *
 * ## hubPrep
 *  H1  snake_case 행 → camelCase 매핑
 *  H2  🔴 SQL 에 user_id · deleted_at IS NULL 조건이 **두 갈래 모두** 걸려 있다
 *  H3  🔴 유산 노트 갈래 — 시트 0장(NOT EXISTS) + notes 비어있지 않음 + **빈 문서 껍데기 제외**
 *  H4  유산 행의 시트 수는 **1 리터럴** (사용자 눈엔 가상 시트 1장이 실재)
 *  H5  🔴 naive 컬럼은 **단일 UTC hop** — 이중 체인·무캐스트 UNION 금지 (세션 TZ 의존 차단)
 *
 * ## streak 캐시 (study_notes.updated_at 이 streak source 다)
 *  K1  생성 → invalidateCache(userId)
 *  K2  수정 → invalidateCache(userId)
 *  K3  삭제 → invalidateCache(userId)
 *  K4  🔴 저장이 롤백되면 **캐시를 안 비운다** (안 바뀐 streak 을 다시 계산할 이유가 없다)
 *  K5  🔴 무효화가 throw 해도 **저장은 성공** (best-effort — 자동저장 경로라 되돌리면 안 된다)
 *  K6  읽기(list·get·backlinks)는 캐시를 안 건드린다
 * ────────────────────────────────────────────────────────────────────────
 */
describe('StudyNotesService', () => {
  let service: StudyNotesService;
  let noteRepo: jest.Mocked<Repository<StudyNote>>;
  let dataSource: { transaction: jest.Mock; query: jest.Mock };
  let streakService: { invalidateCache: jest.Mock };

  const USER_ID = 'user-1';
  const NOTE_ID = 'note-1';
  const OTHER_NOTE_ID = 'note-2';
  const FOLDER_ID = 'folder-1';
  const NOW = new Date('2026-08-18T00:00:00Z');

  const makeNote = (o: Partial<StudyNote> = {}): StudyNote =>
    ({
      id: NOTE_ID,
      userId: USER_ID,
      folderId: null,
      title: '알고리즘 정리',
      content: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...o,
    }) as StudyNote;

  const makeNotes = (n: number): StudyNote[] =>
    Array.from({ length: n }, (_, i) =>
      makeNote({ id: `note-${i}`, title: `노트${i}` }),
    );

  /** 멘션 노드 하나를 담은 tiptap doc 문자열 */
  const docWithMentions = (...noteIds: string[]) =>
    JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: noteIds.map((noteId) => ({
            type: MENTION_NODE_TYPE,
            attrs: { noteId },
          })),
        },
      ],
    });

  interface LinkRow {
    fromId: string;
    fromType: string;
    toNoteId: string;
  }

  /**
   * 트랜잭션 흉내 — **콜백이 throw 하면 그 안에서 쌓인 write 를 전부 버린다.**
   * 실 DB rollback 이 하는 일을 흉내 내야 "링크 재계산 실패 → 저장 롤백" 이 진짜 검증된다.
   * mock 이 write 를 그냥 통과시키면 롤백 테스트는 항상 통과해 아무것도 안 본다.
   */
  interface TxWorld {
    notes: StudyNote[];
    folders: StudyNoteFolder[];
    links: LinkRow[];
    /** 커밋된 최종 상태 — 롤백되면 시작 시점 그대로 */
    committedNotes: StudyNote[];
    committedLinks: LinkRow[];
    repoRequests: unknown[];
    saveCalls: number;
    removeCalls: number;
    linkDeleteCalls: number;
    linkInsertCalls: number;
    opened: number;
    failOnLinkInsert: boolean;
  }
  let tx: TxWorld;

  /** uuid 형식이어야 멘션 추출을 통과한다 (추출기가 uuid 아닌 값을 버린다) */
  const uuid = (n: number) =>
    `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

  const installTransaction = () => {
    dataSource.transaction.mockImplementation(
      async (cb: (em: EntityManager) => Promise<unknown>) => {
        tx.opened += 1;
        const notes = [...tx.notes];
        const links = [...tx.links];

        const noteTxRepo = {
          count: async ({ where }: { where: { userId: string } }) =>
            notes.filter((n) => n.userId === where.userId).length,
          create: (o: Partial<StudyNote>) => ({ ...o }) as StudyNote,
          save: async (e: StudyNote) => {
            tx.saveCalls += 1;
            const i = notes.findIndex((n) => n.id === e.id);
            if (e.id && i >= 0) {
              notes[i] = e;
              return e;
            }
            const row = {
              ...e,
              id: `new-${notes.length}`,
              createdAt: NOW,
              updatedAt: NOW,
            };
            notes.push(row);
            return row;
          },
          findOne: async ({
            where,
          }: {
            where: { id: string; userId: string };
          }) =>
            notes.find((n) => n.id === where.id && n.userId === where.userId) ??
            null,
          remove: async (e: StudyNote) => {
            tx.removeCalls += 1;
            const i = notes.findIndex((n) => n.id === e.id);
            if (i >= 0) notes.splice(i, 1);
            return e;
          },
          // syncStudyNoteLinks 의 소유권 필터 — where.id 는 `In(ids)` 라 value 가 **배열**이다
          find: async ({
            where,
          }: {
            where: { id: FindOperator<string[]>; userId: string };
          }) => {
            const wanted = where.id.value;
            return notes
              .filter((n) => n.userId === where.userId && wanted.includes(n.id))
              .map((n) => ({ id: n.id }) as StudyNote);
          },
        };

        const folderTxRepo = {
          findOne: async ({
            where,
          }: {
            where: { id: string; userId: string };
          }) =>
            tx.folders.find(
              (f) => f.id === where.id && f.userId === where.userId,
            ) ?? null,
        };

        const linkTxRepo = {
          delete: async (criteria: { fromId: string; fromType: string }) => {
            tx.linkDeleteCalls += 1;
            for (let i = links.length - 1; i >= 0; i--) {
              if (
                links[i].fromId === criteria.fromId &&
                links[i].fromType === criteria.fromType
              ) {
                links.splice(i, 1);
              }
            }
          },
          insert: async (rows: LinkRow[]) => {
            tx.linkInsertCalls += 1;
            if (tx.failOnLinkInsert) {
              throw new Error('링크 INSERT 실패 (제약 위반 흉내)');
            }
            links.push(...rows);
          },
        };

        const em = {
          getRepository: (entity: unknown) => {
            tx.repoRequests.push(entity);
            if (entity === StudyNote) return noteTxRepo;
            if (entity === StudyNoteFolder) return folderTxRepo;
            if (entity === StudyNoteLink) return linkTxRepo;
            throw new Error(`예상 못 한 엔티티 요청: ${String(entity)}`);
          },
        } as unknown as EntityManager;

        const result = await cb(em); // throw 하면 notes·links 는 버려진다
        tx.committedNotes = notes;
        tx.committedLinks = links;
        return result;
      },
    );
  };

  beforeEach(async () => {
    noteRepo = mock<Repository<StudyNote>>();
    dataSource = { transaction: jest.fn(), query: jest.fn() };
    streakService = { invalidateCache: jest.fn() };

    tx = {
      notes: [],
      folders: [],
      links: [],
      committedNotes: [],
      committedLinks: [],
      repoRequests: [],
      saveCalls: 0,
      removeCalls: 0,
      linkDeleteCalls: 0,
      linkInsertCalls: 0,
      opened: 0,
      failOnLinkInsert: false,
    };
    installTransaction();
    dataSource.query.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StudyNotesService,
        { provide: getRepositoryToken(StudyNote), useValue: noteRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: StreakService, useValue: streakService },
      ],
    }).compile();

    service = module.get(StudyNotesService);
  });

  // ── list / get ──

  describe('list', () => {
    it('L1) snake_case 행 → camelCase 매핑 (backlinkCount 포함)', async () => {
      dataSource.query.mockResolvedValue([
        {
          id: NOTE_ID,
          title: '알고리즘',
          folder_id: FOLDER_ID,
          updated_at: NOW,
          backlink_count: 2,
        },
      ]);

      await expect(service.list(USER_ID)).resolves.toEqual([
        {
          id: NOTE_ID,
          title: '알고리즘',
          folderId: FOLDER_ID,
          updatedAt: NOW,
          backlinkCount: 2,
        },
      ]);
    });

    it('L2) 🔴 본문 미포함 · user_id 스코프 · 최근 수정순', async () => {
      await service.list(USER_ID);

      const [sql, params] = dataSource.query.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(params).toEqual([USER_ID]);
      // 본문은 목록에 안 실린다 — select 에 content 가 없다는 게 근거
      expect(sql).not.toContain('n.content');
      expect(sql).not.toMatch(/SELECT[\s\S]*\bcontent\b/);
      expect(sql).toContain('n.user_id = $1');
      expect(sql).toContain('ORDER BY n.updated_at DESC');
    });

    it('L3) 🔴 백링크 수는 **출처가 내 것인** 링크만 센다 (패널과 같은 기준)', async () => {
      await service.list(USER_ID);

      const [sql] = dataSource.query.mock.calls[0] as [string];
      // study 소스 — 출처 노트가 내 것
      expect(sql).toContain('JOIN study_notes src ON src.id = l.from_id');
      expect(sql).toContain('src.user_id = $1');
      // prep_sheet 소스 — 출처 시트의 카드가 내 것 · 삭제 안 된 카드
      expect(sql).toContain('a.user_id = $1');
      expect(sql).toContain('a.deleted_at IS NULL');
      // 링크 0건인 노트도 목록에서 빠지지 않는다
      expect(sql).toContain('LEFT JOIN');
      expect(sql).toContain('COALESCE(b.cnt, 0)::int AS backlink_count');
    });

    it('L4) 링크 없는 노트 → backlinkCount 0 (행이 사라지지 않는다)', async () => {
      dataSource.query.mockResolvedValue([
        {
          id: NOTE_ID,
          title: '외톨이 노트',
          folder_id: null,
          updated_at: NOW,
          backlink_count: 0,
        },
      ]);

      const rows = await service.list(USER_ID);

      expect(rows).toHaveLength(1);
      expect(rows[0].backlinkCount).toBe(0);
    });
  });

  it('G1) get — 정상 (본문 포함)', async () => {
    const note = makeNote({ content: '{"type":"doc"}' });
    noteRepo.findOne.mockResolvedValue(note);

    await expect(service.get(USER_ID, NOTE_ID)).resolves.toBe(note);
  });

  it('G2·G3) 🔴 없는 노트·남의 노트 → 404 (조회가 user_id 로 잠긴다)', async () => {
    noteRepo.findOne.mockResolvedValue(null);

    await expect(service.get(USER_ID, NOTE_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(noteRepo.findOne).toHaveBeenCalledWith({
      where: { id: NOTE_ID, userId: USER_ID },
    });
  });

  // ── create ──

  describe('create', () => {
    it('C1) 정상 — 제목 trim · content null · folder null', async () => {
      const note = await service.create(USER_ID, { title: '  CS 정리  ' });

      expect(note.title).toBe('CS 정리');
      expect(note.userId).toBe(USER_ID);
      expect(note.content).toBeNull();
      expect(note.folderId).toBeNull();
      expect(tx.committedNotes).toHaveLength(1);
    });

    it("C2) 🔴 제목 미전달 → '' (빈 제목이 정상 값)", async () => {
      const note = await service.create(USER_ID, {});

      expect(note.title).toBe('');
    });

    it("C3) 제목 공백만 → ''", async () => {
      const note = await service.create(USER_ID, { title: '    ' });

      expect(note.title).toBe('');
    });

    it(`C4) 제목 ${NOTE_TITLE_MAX_CHARS}자 경계 → OK`, async () => {
      const title = 'ㄱ'.repeat(NOTE_TITLE_MAX_CHARS);

      await expect(service.create(USER_ID, { title })).resolves.toMatchObject({
        title,
      });
    });

    it(`C5) 제목 ${NOTE_TITLE_MAX_CHARS + 1}자 → 400 · 트랜잭션 미개시`, async () => {
      await expect(
        service.create(USER_ID, {
          title: 'ㄱ'.repeat(NOTE_TITLE_MAX_CHARS + 1),
        }),
      ).rejects.toThrow(
        new BadRequestException(
          `제목은 공백을 뺀 ${NOTE_TITLE_MAX_CHARS}자까지 입력할 수 있어요.`,
        ),
      );
      expect(tx.opened).toBe(0);
    });

    it('C6) 앞뒤 공백 붙은 102자 → trim 후 100 → OK', async () => {
      const core = 'ㄱ'.repeat(NOTE_TITLE_MAX_CHARS);

      await expect(
        service.create(USER_ID, { title: ` ${core} ` }),
      ).resolves.toMatchObject({ title: core });
    });

    it('C7) content 빈 문자열 → null', async () => {
      const note = await service.create(USER_ID, { content: '' });

      expect(note.content).toBeNull();
    });

    it(`C8) 캡 경계 ${MAX_NOTES_PER_USER - 1}개 → OK`, async () => {
      tx.notes = makeNotes(MAX_NOTES_PER_USER - 1);

      await expect(
        service.create(USER_ID, { title: '마지막' }),
      ).resolves.toMatchObject({ title: '마지막' });
    });

    it(`C9) 🔴 캡 ${MAX_NOTES_PER_USER}개 → 400 · 문구에 숫자 · save 미호출`, async () => {
      tx.notes = makeNotes(MAX_NOTES_PER_USER);

      await expect(service.create(USER_ID, { title: '넘침' })).rejects.toThrow(
        new BadRequestException(
          `공부 노트는 ${MAX_NOTES_PER_USER}개까지 만들 수 있어요 (현재 ${MAX_NOTES_PER_USER}개).`,
        ),
      );
      expect(tx.saveCalls).toBe(0);
    });

    it('C10) folderId 지정(내 폴더) → OK', async () => {
      tx.folders = [{ id: FOLDER_ID, userId: USER_ID } as StudyNoteFolder];

      const note = await service.create(USER_ID, {
        title: '분류됨',
        folderId: FOLDER_ID,
      });

      expect(note.folderId).toBe(FOLDER_ID);
    });

    it('C11) 🔴 남의 폴더·없는 폴더 → 400 · save 미호출', async () => {
      tx.folders = [
        { id: FOLDER_ID, userId: 'someone-else' } as StudyNoteFolder,
      ];

      await expect(
        service.create(USER_ID, { title: '남의 폴더', folderId: FOLDER_ID }),
      ).rejects.toThrow(new BadRequestException('폴더를 찾을 수 없어요.'));
      expect(tx.saveCalls).toBe(0);
    });

    it('C12) content 에 멘션 → 링크 insert', async () => {
      const target = makeNote({ id: uuid(1) });
      tx.notes = [target];

      await service.create(USER_ID, { content: docWithMentions(uuid(1)) });

      expect(tx.committedLinks).toEqual([
        { fromId: 'new-1', fromType: 'study', toNoteId: uuid(1) },
      ]);
    });

    it('C13) content 없음 → 링크 repo 를 아예 안 부른다', async () => {
      await service.create(USER_ID, { title: '빈 노트' });

      expect(tx.repoRequests).not.toContain(StudyNoteLink);
      expect(tx.linkDeleteCalls).toBe(0);
    });

    it('C14) 🔴 링크 insert 실패 → 노트까지 롤백 (부분 저장 없음)', async () => {
      tx.notes = [makeNote({ id: uuid(1) })];
      tx.failOnLinkInsert = true;

      await expect(
        service.create(USER_ID, { content: docWithMentions(uuid(1)) }),
      ).rejects.toThrow('링크 INSERT 실패 (제약 위반 흉내)');
      // 커밋 자체가 없었다
      expect(tx.committedNotes).toEqual([]);
      expect(tx.committedLinks).toEqual([]);
    });
  });

  // ── update ──

  describe('update', () => {
    beforeEach(() => {
      tx.notes = [makeNote({ content: '{"old":1}' })];
      noteRepo.findOne.mockResolvedValue(tx.notes[0]);
    });

    it('U1) 제목 변경 (+trim)', async () => {
      const saved = await service.update(USER_ID, NOTE_ID, {
        title: '  바뀐 제목  ',
      });

      expect(saved.title).toBe('바뀐 제목');
    });

    it('U2) content 변경 → 링크 재계산', async () => {
      const target = makeNote({ id: uuid(1) });
      tx.notes.push(target);

      await service.update(USER_ID, NOTE_ID, {
        content: docWithMentions(uuid(1)),
      });

      expect(tx.committedLinks).toEqual([
        { fromId: NOTE_ID, fromType: 'study', toNoteId: uuid(1) },
      ]);
    });

    it('U3) content 빈 문자열 → null · 링크 전부 제거', async () => {
      tx.links = [{ fromId: NOTE_ID, fromType: 'study', toNoteId: uuid(1) }];

      const saved = await service.update(USER_ID, NOTE_ID, { content: '' });

      expect(saved.content).toBeNull();
      expect(tx.committedLinks).toEqual([]);
    });

    it('U4) 🔴 content 미전달 → 링크 재계산 안 함 (제목만 바꿔도 백링크가 안 흔들린다)', async () => {
      tx.links = [{ fromId: NOTE_ID, fromType: 'study', toNoteId: uuid(1) }];

      await service.update(USER_ID, NOTE_ID, { title: '제목만' });

      expect(tx.linkDeleteCalls).toBe(0);
      expect(tx.committedLinks).toHaveLength(1);
    });

    it('U5) folderId null 명시 → 미분류', async () => {
      tx.notes[0].folderId = FOLDER_ID;

      const saved = await service.update(USER_ID, NOTE_ID, { folderId: null });

      expect(saved.folderId).toBeNull();
    });

    it('U6) 🔴 folderId 미전달 → 폴더 불변 (자동저장이 폴더를 풀면 안 된다)', async () => {
      tx.notes[0].folderId = FOLDER_ID;

      const saved = await service.update(USER_ID, NOTE_ID, {
        content: '{"new":1}',
      });

      expect(saved.folderId).toBe(FOLDER_ID);
    });

    it(`U7) 제목 ${NOTE_TITLE_MAX_CHARS + 1}자 → 400 · 트랜잭션 미개시`, async () => {
      await expect(
        service.update(USER_ID, NOTE_ID, {
          title: 'ㄱ'.repeat(NOTE_TITLE_MAX_CHARS + 1),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(tx.opened).toBe(0);
    });

    it('U8) 🔴 없는 노트·남의 노트 → 404 · 트랜잭션 미개시', async () => {
      noteRepo.findOne.mockResolvedValue(null);

      await expect(
        service.update(USER_ID, NOTE_ID, { title: 'x' }),
      ).rejects.toThrow(NotFoundException);
      expect(tx.opened).toBe(0);
    });

    it('U9) 남의 폴더로 이동 → 400 · save 미호출', async () => {
      tx.folders = [
        { id: FOLDER_ID, userId: 'someone-else' } as StudyNoteFolder,
      ];

      await expect(
        service.update(USER_ID, NOTE_ID, { folderId: FOLDER_ID }),
      ).rejects.toThrow(BadRequestException);
      expect(tx.saveCalls).toBe(0);
    });

    it('U10) 🔴 링크 재계산 실패 → 저장 롤백', async () => {
      tx.notes.push(makeNote({ id: uuid(1) }));
      tx.failOnLinkInsert = true;

      await expect(
        service.update(USER_ID, NOTE_ID, {
          title: '새 제목',
          content: docWithMentions(uuid(1)),
        }),
      ).rejects.toThrow('링크 INSERT 실패 (제약 위반 흉내)');
      expect(tx.committedNotes).toEqual([]); // 커밋 없음
    });

    it('U11) 🔴 last-write-wins — 연속 두 번 저장하면 마지막 값', async () => {
      await service.update(USER_ID, NOTE_ID, { content: '{"tab":"A"}' });
      const second = await service.update(USER_ID, NOTE_ID, {
        content: '{"tab":"B"}',
      });

      expect(second.content).toBe('{"tab":"B"}');
      expect(tx.committedNotes[0].content).toBe('{"tab":"B"}');
    });

    it('U12) 멘션 제거 → 링크도 사라진다 (delete 만, insert 없음)', async () => {
      tx.links = [{ fromId: NOTE_ID, fromType: 'study', toNoteId: uuid(1) }];

      await service.update(USER_ID, NOTE_ID, {
        content: '{"type":"doc","content":[]}',
      });

      expect(tx.linkDeleteCalls).toBe(1);
      expect(tx.linkInsertCalls).toBe(0);
      expect(tx.committedLinks).toEqual([]);
    });

    it('U13) 🔴 자기 자신 멘션 → 무해 (예외 없음 · 링크 1행)', async () => {
      tx.notes = [makeNote({ id: uuid(7) })];
      noteRepo.findOne.mockResolvedValue(tx.notes[0]);

      await expect(
        service.update(USER_ID, uuid(7), { content: docWithMentions(uuid(7)) }),
      ).resolves.toBeDefined();
      expect(tx.committedLinks).toEqual([
        { fromId: uuid(7), fromType: 'study', toNoteId: uuid(7) },
      ]);
    });
  });

  // ── remove ──

  describe('remove', () => {
    it('D1) 정상 — 노트 삭제 + 내보낸 링크 삭제', async () => {
      tx.notes = [makeNote()];
      tx.links = [
        { fromId: NOTE_ID, fromType: 'study', toNoteId: uuid(1) },
        // 다른 문서가 내보낸 링크는 그대로 남는다
        { fromId: OTHER_NOTE_ID, fromType: 'study', toNoteId: uuid(1) },
      ];

      await service.remove(USER_ID, NOTE_ID);

      expect(tx.removeCalls).toBe(1);
      expect(tx.committedNotes).toEqual([]);
      expect(tx.committedLinks).toEqual([
        { fromId: OTHER_NOTE_ID, fromType: 'study', toNoteId: uuid(1) },
      ]);
    });

    it('D2) 없는 노트·남의 노트 → 404 · 링크도 안 지운다', async () => {
      tx.notes = [makeNote({ userId: 'someone-else' })];

      await expect(service.remove(USER_ID, NOTE_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(tx.linkDeleteCalls).toBe(0);
      expect(tx.removeCalls).toBe(0);
    });

    it('D3) 🔴 삭제와 링크 정리가 한 트랜잭션', async () => {
      tx.notes = [makeNote()];

      await service.remove(USER_ID, NOTE_ID);

      expect(tx.opened).toBe(1);
      expect(tx.repoRequests).toContain(StudyNote);
      expect(tx.repoRequests).toContain(StudyNoteLink);
    });
  });

  // ── backlinks ──

  describe('backlinks', () => {
    it('B1) 🔴 남의 노트 → 404 · 쿼리를 던지지도 않는다', async () => {
      noteRepo.findOne.mockResolvedValue(null);

      await expect(service.backlinks(USER_ID, NOTE_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('B2·B3) study·prep_sheet 소스 매핑', async () => {
      noteRepo.findOne.mockResolvedValue(makeNote());
      dataSource.query.mockResolvedValue([
        {
          from_type: 'study',
          from_id: OTHER_NOTE_ID,
          title: '자료구조',
          company_name: null,
          step_name: null,
          application_id: null,
          step_id: null,
        },
        {
          from_type: 'prep_sheet',
          from_id: 'sheet-9',
          title: null,
          company_name: '삼성전자',
          step_name: '1차 면접',
          application_id: 'app-9',
          step_id: 'step-9',
        },
      ]);

      const result = await service.backlinks(USER_ID, NOTE_ID);

      expect(result).toEqual([
        {
          fromType: 'study',
          fromId: OTHER_NOTE_ID,
          label: '자료구조',
          applicationId: null,
          stepId: null,
        },
        {
          fromType: 'prep_sheet',
          fromId: 'sheet-9',
          label: '삼성전자 — 1차 면접',
          applicationId: 'app-9',
          stepId: 'step-9',
        },
      ]);
    });

    it('B4) 🔴 SQL 이 두 소스 모두 user_id 로 잠겨 있다', async () => {
      noteRepo.findOne.mockResolvedValue(makeNote());

      await service.backlinks(USER_ID, NOTE_ID);

      const [sql, params] = dataSource.query.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(params).toEqual([NOTE_ID, USER_ID]);
      // study 소스는 study_notes.user_id, prep 소스는 applications.user_id 로 잠근다
      expect(sql).toContain('sn.user_id = $2');
      expect(sql).toContain('a.user_id = $2');
      expect(sql).toContain('a.deleted_at IS NULL');
    });

    it('B5) 링크 없음 → []', async () => {
      noteRepo.findOne.mockResolvedValue(makeNote());
      dataSource.query.mockResolvedValue([]);

      await expect(service.backlinks(USER_ID, NOTE_ID)).resolves.toEqual([]);
    });
  });

  // ── hubPrep ──

  describe('hubPrep', () => {
    it('H1) snake_case 행 → camelCase 매핑', async () => {
      dataSource.query.mockResolvedValue([
        {
          application_id: 'app-1',
          company_name: '카카오',
          step_id: 'step-1',
          step_name: '서류',
          sheet_count: 3,
          last_updated_at: NOW,
        },
      ]);

      await expect(service.hubPrep(USER_ID)).resolves.toEqual([
        {
          applicationId: 'app-1',
          companyName: '카카오',
          stepId: 'step-1',
          stepName: '서류',
          sheetCount: 3,
          lastUpdatedAt: NOW,
        },
      ]);
    });

    it('H2) 🔴 user_id · deleted_at IS NULL 이 두 갈래 모두에 걸려 있다', async () => {
      await service.hubPrep(USER_ID);

      const [sql, params] = dataSource.query.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(params).toEqual([USER_ID]);
      // UNION ALL 양쪽 — 한쪽만 잠기면 그쪽으로 남의 카드가 샌다
      expect(sql.match(/a\.user_id = \$1/g)).toHaveLength(2);
      expect(sql.match(/a\.deleted_at IS NULL/g)).toHaveLength(2);
    });

    it('H3) 🔴 유산 노트 갈래 — 시트 0장 + notes 비어있지 않음', async () => {
      await service.hubPrep(USER_ID);

      const [sql] = dataSource.query.mock.calls[0] as [string];
      // 시트가 있는 스텝은 A 갈래에서 이미 잡힌다 — 안 걸러내면 같은 스텝이 두 줄로 뜬다
      expect(sql).toMatch(
        /NOT EXISTS\s*\(\s*SELECT 1 FROM step_note_sheets sh WHERE sh\.step_id = st\.id\s*\)/,
      );
      expect(sql).toContain('st.notes IS NOT NULL');
      expect(sql).toContain("btrim(st.notes) <> ''");
      // 🔴 빈 문서 껍데기 제외 — 에디터만 열었다 나간 스텝이 유령 행으로 뜨면 안 된다
      expect(sql).toContain(
        '\'{"type":"doc","content":[{"type":"paragraph"}]}\'',
      );
      expect(sql).toContain("regexp_replace(st.notes, '\\s+', '', 'g')");
    });

    it('H4) 유산 행의 시트 수는 1 리터럴 (가상 시트 1장)', async () => {
      await service.hubPrep(USER_ID);

      const [sql] = dataSource.query.mock.calls[0] as [string];
      expect(sql).toContain('1 AS sheet_count');
    });

    it('H5) 🔴 naive 컬럼은 단일 UTC hop — 이중 체인·무캐스트 UNION 금지', async () => {
      await service.hubPrep(USER_ID);

      const [sql] = dataSource.query.mock.calls[0] as [string];
      /*
        applications.updated_at 은 naive timestamp, 시트 쪽은 timestamptz 다.
        캐스트 없이 UNION 하면 Postgres 가 **세션 TZ** 로 승격해 서버 TZ 에 따라 값이 흔들린다.
        반대로 이중 체인(...'UTC' ... 'Asia/Seoul')을 쓰면 instant 가 아니라 KST 벽시각이
        나가서 클라이언트가 다시 9h 를 더한다.
      */
      expect(sql).toContain(
        "a.updated_at AT TIME ZONE 'UTC' AS last_updated_at",
      );
      expect(sql).not.toMatch(/AT TIME ZONE 'UTC' AT TIME ZONE/);
    });
  });

  // ── streak 캐시 ──

  describe('streak 캐시 무효화', () => {
    it('K1) 생성 → invalidateCache(userId)', async () => {
      await service.create(USER_ID, { title: '오늘 공부' });

      expect(streakService.invalidateCache).toHaveBeenCalledWith(USER_ID);
    });

    it('K2) 수정 → invalidateCache(userId)', async () => {
      tx.notes = [makeNote()];
      noteRepo.findOne.mockResolvedValue(tx.notes[0]);

      await service.update(USER_ID, NOTE_ID, { content: '{"x":1}' });

      expect(streakService.invalidateCache).toHaveBeenCalledWith(USER_ID);
    });

    it('K3) 삭제 → invalidateCache(userId)', async () => {
      tx.notes = [makeNote()];

      await service.remove(USER_ID, NOTE_ID);

      expect(streakService.invalidateCache).toHaveBeenCalledWith(USER_ID);
    });

    it('K4) 🔴 저장이 롤백되면 캐시를 안 비운다', async () => {
      tx.notes = [makeNote({ id: uuid(1) })];
      tx.failOnLinkInsert = true;

      await expect(
        service.create(USER_ID, { content: docWithMentions(uuid(1)) }),
      ).rejects.toThrow();
      expect(streakService.invalidateCache).not.toHaveBeenCalled();

      // 캡 초과처럼 아예 쓰지도 못한 경우도 마찬가지
      tx.notes = makeNotes(MAX_NOTES_PER_USER);
      await expect(service.create(USER_ID, {})).rejects.toThrow(
        BadRequestException,
      );
      expect(streakService.invalidateCache).not.toHaveBeenCalled();
    });

    it('K5) 🔴 무효화가 throw 해도 저장은 성공 (best-effort)', async () => {
      streakService.invalidateCache.mockImplementation(() => {
        throw new Error('캐시 정리 실패');
      });
      tx.notes = [makeNote()];
      noteRepo.findOne.mockResolvedValue(tx.notes[0]);

      // 자동저장이 굴리는 경로다 — 이미 커밋된 저장을 "실패" 로 되돌리면
      // 프론트가 저장된 글에 대해 실패 토스트를 띄우고 재시도한다
      await expect(
        service.update(USER_ID, NOTE_ID, { content: '{"saved":true}' }),
      ).resolves.toMatchObject({ content: '{"saved":true}' });
      await expect(
        service.create(USER_ID, { title: '새 노트' }),
      ).resolves.toBeDefined();
      await expect(service.remove(USER_ID, NOTE_ID)).resolves.toBeUndefined();

      expect(streakService.invalidateCache).toHaveBeenCalledTimes(3);
    });

    it('K6) 읽기(list·get·backlinks·hub)는 캐시를 안 건드린다', async () => {
      noteRepo.find.mockResolvedValue([]);
      noteRepo.findOne.mockResolvedValue(makeNote());

      await service.list(USER_ID);
      await service.get(USER_ID, NOTE_ID);
      await service.backlinks(USER_ID, NOTE_ID);
      await service.hubPrep(USER_ID);

      expect(streakService.invalidateCache).not.toHaveBeenCalled();
    });
  });
});
