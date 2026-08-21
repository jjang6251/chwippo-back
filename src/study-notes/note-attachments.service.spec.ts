import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, EntityManager, FindOperator } from 'typeorm';
import { FilesService } from '../files/files.service';
import { StorageUsageService } from '../myinfo/storage-usage.service';
import { CreateNoteAttachmentDto } from './dto/note-attachment.dto';
import { NoteAttachment } from './note-attachment.entity';
import {
  NEW_ATTACHMENT_GRACE_SECONDS,
  NoteAttachmentsService,
} from './note-attachments.service';
import { StudyNote } from './study-note.entity';

/**
 * **공부 노트 첨부** 서비스 spec.
 *
 * ────────────────────────────────────────────────────────────────────────
 * 아래 시나리오를 **먼저 나열하고** 코드를 확인했다. 통과시키려고 짠 게 아니라
 * "사용자 이미지를 잃게 만드는 경로" 와 "용량을 공짜로 쓰게 만드는 경로" 를 노렸다.
 *
 * ## register
 *  N1  정상 → `{ id, fileUrl }` · kind='image' · user_id·note_id 실림
 *  N2  🔴 없는 노트·**남의 노트** → 404 · 파일 검증도 cap 도 안 본다 (존재 여부 누출 없음)
 *  N3  🔴 남의 파일 URL → 403 · insert 미호출 (쓰기 IDOR)
 *  N4  🔴 cap 초과 → 400 · insert 미호출 · 문구에 숫자
 *  N5  cap 경계 — 한도−1 / 한도 통과 · 한도+1 400
 *  N6  🔴 **멱등** — 같은 fileUrl 재등록 → 기존 행 반환 · **cap 재청구 없음** · insert 미호출
 *  N7  🔴 순서 — 소유권 → assertOwnFileUrl → **FOR UPDATE** → cap → insert
 *  N8  🔴 사용자 행 락(`SELECT ... FOR UPDATE`)을 실제로 잡는다 (동시 등록 직렬화)
 *  N9  전 과정이 **한 트랜잭션** — cap 실패 시 insert 가 커밋되지 않는다
 *
 * ## reconcile
 *  N10 본문이 그대로 가리킴 → 아무것도 안 지운다 · []
 *  N11 일부 제거 → **미참조만** delete · 그 URL 반환
 *  N12 🔴 본문 비움(참조 0) → 전부 delete (안 지우면 용량이 영원히 안 돌아온다)
 *  N13 🔴 **파싱 실패 → delete 미호출** · [] (한 번의 깨진 저장이 이미지를 다 날리면 안 된다)
 *  N14 content null → 참조 0 취급 (정상적으로 읽은 빈 노트)
 *  N15 strokes_url 있는 행 → URL **2개** 반환 (png·json 별개 객체)
 *  N16 첨부 0개 노트 → delete 미호출 · []
 *  N17 🔴 **다른 노트의 첨부는 안 건드린다** (where note_id)
 *  N23 🔴 **등록 60초 안**의 행은 미참조여도 생존 (자동저장이 등록을 앞지른 race)
 *  N24 🔴 유예 창을 지난 미참조 행은 정리 (끝내 확정 안 된 진짜 고아)
 *  N25 신규·고아가 섞이면 고아만
 *  N26 🔴 시계는 **DB 것** — `now() - interval`, 앱에서 계산한 값을 안 넘긴다
 *
 * ## collectFileUrls
 *  N18 file_url + strokes_url 수집
 *  N19 첨부 없음 → []
 *
 * ## cleanupFiles
 *  N20 URL 마다 deleteFile 호출
 *  N21 🔴 **R2 삭제가 실패해도 throw 하지 않는다** (외부 의존 실패 — best-effort)
 *  N22 빈 목록 → 호출 0
 * ────────────────────────────────────────────────────────────────────────
 */
describe('NoteAttachmentsService', () => {
  let service: NoteAttachmentsService;
  let dataSource: { transaction: jest.Mock };
  let filesService: {
    assertOwnFileUrl: jest.Mock;
    deleteFile: jest.Mock;
  };
  let storageUsage: { assertWithinLimit: jest.Mock };

  const USER_ID = 'user-1';
  const OTHER_USER_ID = 'user-2';
  const NOTE_ID = 'note-1';
  const OTHER_NOTE_ID = 'note-2';
  const R2 = 'https://files.example.com';
  const FILE_URL = `${R2}/users/${USER_ID}/study-note/image/a.jpg`;
  const NOW = new Date('2026-08-20T00:00:00Z');

  const uuid = (n: number) =>
    `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

  const dto = (o: Partial<CreateNoteAttachmentDto> = {}) => ({
    fileUrl: FILE_URL,
    fileSizeBytes: 1024,
    ...o,
  });

  const makeAttachment = (o: Partial<NoteAttachment> = {}): NoteAttachment =>
    ({
      id: uuid(1),
      userId: USER_ID,
      noteId: NOTE_ID,
      kind: 'image',
      fileUrl: FILE_URL,
      fileSizeBytes: 1024,
      strokesUrl: null,
      strokesSizeBytes: null,
      createdAt: NOW,
      ...o,
    }) as NoteAttachment;

  /**
   * 트랜잭션 흉내 — 콜백이 throw 하면 그 안의 write 를 버린다.
   * mock 이 write 를 그냥 통과시키면 "cap 실패 → 롤백" 테스트가 아무것도 안 본다.
   */
  interface TxWorld {
    notes: StudyNote[];
    attachments: NoteAttachment[];
    committedAttachments: NoteAttachment[];
    /** 실제 실행 순서 — 소유권·파일검증·락·cap·insert 가 이 순서여야 한다 */
    ops: string[];
    rawQueries: Array<{ sql: string; params: unknown[] }>;
    saveCalls: number;
    opened: number;
  }
  let tx: TxWorld;

  const installTransaction = () => {
    dataSource.transaction.mockImplementation(
      async (cb: (em: EntityManager) => Promise<unknown>) => {
        tx.opened += 1;
        const attachments = [...tx.attachments];

        const noteTxRepo = {
          findOne: async ({
            where,
          }: {
            where: { id: string; userId: string };
          }) => {
            tx.ops.push('note-lookup');
            return (
              tx.notes.find(
                (n) => n.id === where.id && n.userId === where.userId,
              ) ?? null
            );
          },
        };

        const attachmentTxRepo = {
          findOne: async ({
            where,
          }: {
            where: { fileUrl: string; userId: string };
          }) =>
            attachments.find(
              (a) => a.fileUrl === where.fileUrl && a.userId === where.userId,
            ) ?? null,
          create: (o: Partial<NoteAttachment>) => ({ ...o }) as NoteAttachment,
          save: async (e: NoteAttachment) => {
            tx.ops.push('insert');
            tx.saveCalls += 1;
            const row = {
              ...e,
              id: uuid(attachments.length + 10),
              createdAt: NOW,
            };
            attachments.push(row);
            return row;
          },
        };

        const em = {
          getRepository: (entity: unknown) => {
            if (entity === StudyNote) return noteTxRepo;
            if (entity === NoteAttachment) return attachmentTxRepo;
            throw new Error(`예상 못 한 엔티티 요청: ${String(entity)}`);
          },
          query: async (sql: string, params: unknown[]) => {
            tx.ops.push('for-update');
            tx.rawQueries.push({ sql, params });
            return [];
          },
        } as unknown as EntityManager;

        const result = await cb(em); // throw 하면 attachments 는 버려진다
        tx.committedAttachments = attachments;
        return result;
      },
    );
  };

  beforeEach(async () => {
    dataSource = { transaction: jest.fn() };
    filesService = {
      assertOwnFileUrl: jest.fn(() => {
        tx.ops.push('assert-own');
      }),
      deleteFile: jest.fn().mockResolvedValue(undefined),
    };
    storageUsage = {
      assertWithinLimit: jest.fn(() => {
        tx.ops.push('cap');
        return Promise.resolve();
      }),
    };

    tx = {
      notes: [{ id: NOTE_ID, userId: USER_ID } as StudyNote],
      attachments: [],
      committedAttachments: [],
      ops: [],
      rawQueries: [],
      saveCalls: 0,
      opened: 0,
    };
    installTransaction();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NoteAttachmentsService,
        { provide: DataSource, useValue: dataSource },
        { provide: FilesService, useValue: filesService },
        { provide: StorageUsageService, useValue: storageUsage },
      ],
    }).compile();

    service = module.get(NoteAttachmentsService);
  });

  // ── register ──────────────────────────────────────────

  describe('register', () => {
    it('N1) 정상 → { id, fileUrl } · kind=image · user_id·note_id 실림', async () => {
      const result = await service.register(USER_ID, NOTE_ID, dto());

      expect(result.fileUrl).toBe(FILE_URL);
      expect(result.id).toBeDefined();
      expect(tx.committedAttachments).toHaveLength(1);
      expect(tx.committedAttachments[0]).toMatchObject({
        userId: USER_ID,
        noteId: NOTE_ID,
        kind: 'image',
        fileUrl: FILE_URL,
        fileSizeBytes: 1024,
        strokesUrl: null,
        strokesSizeBytes: null,
      });
    });

    it('N1) 응답은 id·fileUrl **두 필드만** (프론트 계약)', async () => {
      const result = await service.register(USER_ID, NOTE_ID, dto());
      expect(Object.keys(result).sort()).toEqual(['fileUrl', 'id']);
    });

    it('N2) 🔴 없는 노트 → 404 · 파일 검증·cap 미호출', async () => {
      await expect(
        service.register(USER_ID, 'no-such-note', dto()),
      ).rejects.toThrow(NotFoundException);

      expect(filesService.assertOwnFileUrl).not.toHaveBeenCalled();
      expect(storageUsage.assertWithinLimit).not.toHaveBeenCalled();
      expect(tx.saveCalls).toBe(0);
    });

    it('N2) 🔴 남의 노트 → 404 (403 이 아니다 — 존재 여부를 알려 주지 않는다)', async () => {
      tx.notes.push({ id: OTHER_NOTE_ID, userId: OTHER_USER_ID } as StudyNote);

      await expect(
        service.register(USER_ID, OTHER_NOTE_ID, dto()),
      ).rejects.toThrow(NotFoundException);
      expect(tx.saveCalls).toBe(0);
    });

    it('N3) 🔴 남의 파일 URL → 403 · insert 미호출 (쓰기 IDOR)', async () => {
      filesService.assertOwnFileUrl.mockImplementation(() => {
        throw new ForbiddenException(
          '본인이 업로드한 파일만 사용할 수 있습니다.',
        );
      });

      await expect(
        service.register(
          USER_ID,
          NOTE_ID,
          dto({
            fileUrl: `${R2}/users/${OTHER_USER_ID}/study-note/image/a.jpg`,
          }),
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(tx.saveCalls).toBe(0);
      expect(storageUsage.assertWithinLimit).not.toHaveBeenCalled();
    });

    it('N4) 🔴 cap 초과 → 400 · insert 미호출 · 커밋 없음', async () => {
      storageUsage.assertWithinLimit.mockRejectedValue(
        new BadRequestException('저장 공간이 부족합니다 (현재 100MB / 100MB).'),
      );

      await expect(service.register(USER_ID, NOTE_ID, dto())).rejects.toThrow(
        '저장 공간이 부족합니다 (현재 100MB / 100MB).',
      );

      expect(tx.saveCalls).toBe(0);
      expect(tx.committedAttachments).toEqual([]);
    });

    it('N5) cap 경계 — 요청 크기가 그대로 assertWithinLimit 에 전달된다', async () => {
      await service.register(USER_ID, NOTE_ID, dto({ fileSizeBytes: 10 }));
      expect(storageUsage.assertWithinLimit).toHaveBeenCalledWith(
        USER_ID,
        10,
        expect.anything(),
      );
    });

    it('N6) 🔴 멱등 — 같은 fileUrl 재등록 → 기존 행 반환 · cap 재청구 없음 · insert 미호출', async () => {
      const existing = makeAttachment({ id: uuid(7) });
      tx.attachments.push(existing);

      const result = await service.register(USER_ID, NOTE_ID, dto());

      expect(result).toEqual({ id: uuid(7), fileUrl: FILE_URL });
      expect(tx.saveCalls).toBe(0);
      expect(storageUsage.assertWithinLimit).not.toHaveBeenCalled();
    });

    it('N6) 멱등 — 다른 노트에서 등록됐던 URL 이어도 행을 늘리지 않는다 (unique file_url)', async () => {
      tx.attachments.push(
        makeAttachment({ id: uuid(8), noteId: OTHER_NOTE_ID }),
      );
      tx.notes.push({ id: OTHER_NOTE_ID, userId: USER_ID } as StudyNote);

      const result = await service.register(USER_ID, NOTE_ID, dto());

      expect(result.id).toBe(uuid(8));
      expect(tx.saveCalls).toBe(0);
    });

    it('N7) 🔴 순서 — 소유권 → 파일 소유 검증 → FOR UPDATE → cap → insert', async () => {
      await service.register(USER_ID, NOTE_ID, dto());
      expect(tx.ops).toEqual([
        'note-lookup',
        'assert-own',
        'for-update',
        'cap',
        'insert',
      ]);
    });

    it('N8) 🔴 사용자 행 락을 실제로 잡는다 (SELECT ... FOR UPDATE)', async () => {
      await service.register(USER_ID, NOTE_ID, dto());

      expect(tx.rawQueries).toHaveLength(1);
      expect(tx.rawQueries[0].sql).toMatch(/FOR UPDATE/i);
      expect(tx.rawQueries[0].sql).toMatch(/FROM users/i);
      expect(tx.rawQueries[0].params).toEqual([USER_ID]);
    });

    it('N9) 전 과정이 한 트랜잭션 (열림 1회)', async () => {
      await service.register(USER_ID, NOTE_ID, dto());
      expect(tx.opened).toBe(1);
    });
  });

  // ── reconcile ─────────────────────────────────────────

  describe('reconcile', () => {
    interface DeleteCriteria {
      id: FindOperator<string[]>;
    }
    let rows: NoteAttachment[];
    let deleted: string[][];
    let clauses: string[];
    let em: EntityManager;

    /**
     * **DB 시계 픽스처.** `Date.now` 를 mock 하지 않는다 — 서비스가 앱 시계를 안 쓰고
     * `now() - interval` 로 자르기 때문이다. 여기선 그 SQL 이 하는 일을 픽스처의
     * `created_at` 과 이 값의 차이로 흉내 낸다.
     */
    const DB_NOW = new Date(NOW.getTime() + 10 * 60_000); // 기본 행은 10분 전 = 유예 창 밖
    /** 5초 전 등록 — 유예 창 **안** (자동저장이 등록을 앞지른 그 순간) */
    const FRESH = new Date(DB_NOW.getTime() - 5_000);

    const doc = (...attachmentIds: string[]) =>
      JSON.stringify({
        type: 'doc',
        content: attachmentIds.map((attachmentId) => ({
          type: 'image',
          attrs: { attachmentId, src: 'https://cdn/x.jpg' },
        })),
      });

    beforeEach(() => {
      rows = [];
      deleted = [];
      clauses = [];
      const repo = {
        createQueryBuilder: () => {
          let wantedNoteId = '';
          const qb = {
            select: () => qb,
            where: (clause: string, params: { noteId: string }) => {
              clauses.push(clause);
              wantedNoteId = params.noteId;
              return qb;
            },
            andWhere: (clause: string) => {
              clauses.push(clause);
              return qb;
            },
            // `WHERE note_id = … AND created_at < now() - interval '60 seconds'` 의 흉내
            getMany: async () =>
              rows.filter(
                (r) =>
                  r.noteId === wantedNoteId &&
                  r.createdAt.getTime() <
                    DB_NOW.getTime() - NEW_ATTACHMENT_GRACE_SECONDS * 1000,
              ),
          };
          return qb;
        },
        delete: async (criteria: DeleteCriteria) => {
          deleted.push(criteria.id.value);
          return { affected: criteria.id.value.length };
        },
      };
      em = {
        getRepository: (entity: unknown) => {
          if (entity === NoteAttachment) return repo;
          throw new Error(`예상 못 한 엔티티 요청: ${String(entity)}`);
        },
      } as unknown as EntityManager;
    });

    it('N10) 본문이 그대로 가리킴 → 아무것도 안 지운다 · []', async () => {
      rows = [makeAttachment({ id: uuid(1) })];
      await expect(
        service.reconcile(em, NOTE_ID, doc(uuid(1))),
      ).resolves.toEqual([]);
      expect(deleted).toEqual([]);
    });

    it('N11) 🔴 일부 제거 → 미참조만 delete · 그 URL 반환', async () => {
      rows = [
        makeAttachment({ id: uuid(1), fileUrl: `${R2}/keep.jpg` }),
        makeAttachment({ id: uuid(2), fileUrl: `${R2}/drop.jpg` }),
      ];

      await expect(
        service.reconcile(em, NOTE_ID, doc(uuid(1))),
      ).resolves.toEqual([`${R2}/drop.jpg`]);
      expect(deleted).toEqual([[uuid(2)]]);
    });

    it('N12) 🔴 본문 비움(참조 0) → 전부 delete (용량이 안 돌아오면 그것대로 샌다)', async () => {
      rows = [
        makeAttachment({ id: uuid(1), fileUrl: `${R2}/a.jpg` }),
        makeAttachment({ id: uuid(2), fileUrl: `${R2}/b.jpg` }),
      ];

      await expect(service.reconcile(em, NOTE_ID, doc())).resolves.toEqual([
        `${R2}/a.jpg`,
        `${R2}/b.jpg`,
      ]);
      expect(deleted).toEqual([[uuid(1), uuid(2)]]);
    });

    it('N13) 🔴 파싱 실패 → delete 미호출 · [] (깨진 저장 한 번에 이미지를 날리지 않는다)', async () => {
      rows = [makeAttachment({ id: uuid(1) })];

      await expect(
        service.reconcile(em, NOTE_ID, '{깨진 JSON'),
      ).resolves.toEqual([]);
      expect(deleted).toEqual([]);
    });

    it('N14) content null → 참조 0 취급 (정상적으로 읽은 빈 노트)', async () => {
      rows = [makeAttachment({ id: uuid(1), fileUrl: `${R2}/a.jpg` })];

      await expect(service.reconcile(em, NOTE_ID, null)).resolves.toEqual([
        `${R2}/a.jpg`,
      ]);
      expect(deleted).toEqual([[uuid(1)]]);
    });

    it('N15) strokes_url 있는 행 → URL 2개 반환 (png·json 별개 객체)', async () => {
      rows = [
        makeAttachment({
          id: uuid(1),
          kind: 'drawing',
          fileUrl: `${R2}/d.png`,
          strokesUrl: `${R2}/d.json`,
          strokesSizeBytes: 100,
        }),
      ];

      await expect(service.reconcile(em, NOTE_ID, doc())).resolves.toEqual([
        `${R2}/d.png`,
        `${R2}/d.json`,
      ]);
    });

    it('N16) 첨부 0개 노트 → delete 미호출 · []', async () => {
      await expect(service.reconcile(em, NOTE_ID, doc())).resolves.toEqual([]);
      expect(deleted).toEqual([]);
    });

    it('N17) 🔴 다른 노트의 첨부는 안 건드린다', async () => {
      rows = [
        makeAttachment({ id: uuid(1), noteId: NOTE_ID }),
        makeAttachment({ id: uuid(2), noteId: OTHER_NOTE_ID }),
      ];

      await service.reconcile(em, NOTE_ID, doc());
      expect(deleted).toEqual([[uuid(1)]]);
    });

    // ── 등록 직후 유예 창 (race) ───────────────────────

    it('N23) 🔴 등록 60초 안의 행은 **미참조여도 살아남는다** (자동저장이 등록을 앞지른 경우)', async () => {
      // 붙여넣기 → placeholder 가 자동저장을 깨움 → attachmentId 없는 본문이 먼저 저장
      rows = [
        makeAttachment({
          id: uuid(1),
          createdAt: FRESH,
          fileUrl: `${R2}/just-registered.jpg`,
        }),
      ];

      await expect(service.reconcile(em, NOTE_ID, doc())).resolves.toEqual([]);
      expect(deleted).toEqual([]);
    });

    it('N24) 🔴 같은 행도 유예 창을 지나면 정리된다 (끝내 확정 안 된 진짜 고아)', async () => {
      rows = [
        makeAttachment({
          id: uuid(1),
          createdAt: new Date(DB_NOW.getTime() - 61_000),
          fileUrl: `${R2}/never-confirmed.jpg`,
        }),
      ];

      await expect(service.reconcile(em, NOTE_ID, doc())).resolves.toEqual([
        `${R2}/never-confirmed.jpg`,
      ]);
      expect(deleted).toEqual([[uuid(1)]]);
    });

    it('N25) 유예 창 안 신규 + 창 밖 고아가 섞이면 **고아만** 지운다', async () => {
      rows = [
        makeAttachment({
          id: uuid(1),
          createdAt: FRESH,
          fileUrl: `${R2}/fresh.jpg`,
        }),
        makeAttachment({ id: uuid(2), fileUrl: `${R2}/old.jpg` }), // 10분 전
      ];

      await expect(service.reconcile(em, NOTE_ID, doc())).resolves.toEqual([
        `${R2}/old.jpg`,
      ]);
      expect(deleted).toEqual([[uuid(2)]]);
    });

    it('N26) 🔴 시계는 **DB 것** — `now() - interval` 로 자른다 (앱 시계 금지)', async () => {
      rows = [makeAttachment({ id: uuid(1) })];

      await service.reconcile(em, NOTE_ID, doc());

      const graceClause = clauses.find((c) => c.includes('createdAt'));
      expect(graceClause).toBeDefined();
      expect(graceClause).toContain('now()');
      expect(graceClause).toContain(
        `interval '${NEW_ATTACHMENT_GRACE_SECONDS} seconds'`,
      );
      // 앱에서 계산한 타임스탬프를 파라미터로 넘기지 않는다
      expect(graceClause).not.toMatch(/:createdAt|:cutoff|:now/);
    });
  });

  // ── collectFileUrls ───────────────────────────────────

  describe('collectFileUrls', () => {
    const emWith = (rows: NoteAttachment[]): EntityManager =>
      ({
        getRepository: () => ({
          find: async ({ where }: { where: { noteId: string } }) =>
            rows.filter((r) => r.noteId === where.noteId),
        }),
      }) as unknown as EntityManager;

    it('N18) file_url + strokes_url 수집', async () => {
      const em = emWith([
        makeAttachment({ fileUrl: `${R2}/a.jpg` }),
        makeAttachment({
          fileUrl: `${R2}/d.png`,
          strokesUrl: `${R2}/d.json`,
        }),
      ]);

      await expect(service.collectFileUrls(em, NOTE_ID)).resolves.toEqual([
        `${R2}/a.jpg`,
        `${R2}/d.png`,
        `${R2}/d.json`,
      ]);
    });

    it('N19) 첨부 없음 → []', async () => {
      await expect(
        service.collectFileUrls(emWith([]), NOTE_ID),
      ).resolves.toEqual([]);
    });
  });

  // ── cleanupFiles ──────────────────────────────────────

  describe('cleanupFiles', () => {
    it('N20) URL 마다 deleteFile 호출', async () => {
      await service.cleanupFiles([`${R2}/a.jpg`, `${R2}/b.jpg`]);
      expect(filesService.deleteFile).toHaveBeenCalledTimes(2);
      expect(filesService.deleteFile).toHaveBeenNthCalledWith(1, `${R2}/a.jpg`);
      expect(filesService.deleteFile).toHaveBeenNthCalledWith(2, `${R2}/b.jpg`);
    });

    it('N21) 한 URL 이 끝나야 다음으로 — 앞 URL 실패가 뒤를 건너뛰지 않는다', async () => {
      // best-effort 의 실체는 `FilesService.deleteFile` 이 실패를 삼키는 계약이다
      // (files.service.spec 「S3 send 실패해도 throw 하지 않음」). 여기선 그 계약 위에서
      // **모든 URL 이 빠짐없이 시도되는지**만 본다. 실 R2 실패 경로는 e2e 가 real
      // FilesService + rejecting S3 로 잠근다.
      await service.cleanupFiles([`${R2}/a.jpg`, `${R2}/b.jpg`, `${R2}/c.jpg`]);
      expect(filesService.deleteFile.mock.calls.map(([u]) => u)).toEqual([
        `${R2}/a.jpg`,
        `${R2}/b.jpg`,
        `${R2}/c.jpg`,
      ]);
    });

    it('N22) 빈 목록 → 호출 0', async () => {
      await service.cleanupFiles([]);
      expect(filesService.deleteFile).not.toHaveBeenCalled();
    });
  });
});
