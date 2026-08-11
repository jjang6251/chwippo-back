import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';
import { mock } from 'jest-mock-extended';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Application } from './application.entity';
import { ApplicationStep } from './application-step.entity';
import { StepNoteSheet } from './step-note-sheet.entity';
import {
  MAX_SHEETS_PER_STEP,
  SHEET_NAME_MAX_CHARS,
  StepNoteSheetsService,
} from './step-note-sheets.service';

/**
 * 준비 노트 **다중 시트** 서비스 spec.
 *
 * ────────────────────────────────────────────────────────────────────────
 * 아래 시나리오를 **먼저 나열하고** 코드를 확인했다. 통과시키려고 짠 게 아니라
 * 깨뜨리려고 짠 목록이다. 15축(정상·경계·권한·동시성·멱등·롤백·불변식) 순회.
 *
 * ## list
 *  L1  정상 — order_index ASC · created_at ASC 로 조회
 *  L2  시트 0장 → **빈 배열** (서버가 가짜 시트를 지어내지 않는다 · 폴백은 프론트 몫)
 *  L3  타 유저 카드 → 404 · step 조회조차 안 한다
 *  L4  IDOR: 다른 카드의 stepId → 404 (stepId 가 appId 소속인지 본다)
 *
 * ## create
 *  C1  0장 → order_index 0 · name trim 저장
 *  C2  3장 있음 → order_index = max+1
 *  C3  order_index 가 연속이 아님(0,5) → 6 (개수가 아니라 **max** 를 본다)
 *  C4  content 미전달 → null
 *  C5  캡 경계 9 + 1 → OK (order_index 9)
 *  C6  🔴 캡 경계 10 + 1 → 400 · 문구에 숫자 10 · save 미호출
 *  C7  이름 공백만("   ") → 400 · **트랜잭션 자체를 안 연다**
 *  C8  이름 빈 문자열 → 400
 *  C9  이름 51자 → 400
 *  C10 이름 50자 경계 → OK
 *  C11 앞뒤 공백 붙은 52자 → trim 후 50 → OK (**trim 먼저** 근거)
 *  C12 ifEmpty=true · 0장 → 생성 · created=true
 *  C13 🔴 ifEmpty=true · 1장 → **기존 첫 시트 반환 · created=false · save 미호출** (승격 멱등)
 *  C14 ifEmpty=true · 여러 장 → order_index 가장 작은 시트를 돌려준다
 *  C15 🔴 ifEmpty=true · 10장(캡 꽉참) → 400 이 아니라 첫 시트 (**멱등 판정이 캡보다 먼저**)
 *  C16 ifEmpty 미전달 · 1장 → 그냥 생성 (일반 추가는 멱등이 아니다)
 *  C17 타 유저 → 404 · save 미호출
 *  C18 IDOR: 다른 카드 stepId → 404
 *  C19 🔴 스텝 행을 **pessimistic_write 로 잠근다** (동시 POST 가 11장·중복 승격을 못 만드는 근거)
 *  C20 🔴 저장 실패 → **전체 롤백** (부분 저장 없음)
 *  C21 캡 검사·order 계산·ifEmpty 판정·INSERT 가 **한 트랜잭션 안**에서 일어난다
 *
 * ## update
 *  U1  name 수정 (+ trim)
 *  U2  content 수정
 *  U3  content 빈 문자열 → null (기존 steps.notes 저장과 같은 정규화)
 *  U4  order_index 수정
 *  U5  미전달 필드는 불변
 *  U6  name 공백만 → 400 · save 미호출
 *  U7  name 51자 → 400
 *  U8  타 유저 → 404
 *  U9  IDOR: 다른 step 의 sheetId → 404
 *  U10 없는 sheetId → 404
 *
 * ## remove
 *  D1  2장 중 1장 삭제 → OK
 *  D2  🔴 마지막 1장 → 400 "시트는 1장 이상 있어야 해요" · remove 미호출
 *  D3  없는 sheetId → 404 (**마지막 1장 판정보다 먼저** — 남의 id 로 상태를 떠보지 못하게)
 *  D4  타 유저 → 404
 *  D5  IDOR: 다른 step 의 sheetId → 404
 *  D6  스텝 행 잠금 (동시 DELETE 가 0장을 못 만든다)
 *
 * ## 🔴 최상위 불변식 — 기존 노트는 절대 안 날아간다
 *  INV1 모든 공개 메서드를 다 돌려도 stepRepo 의 **쓰기 메서드 호출 0**
 *  INV2 트랜잭션 em 의 save/update/delete/insert 호출 0 (시트 쓰기는 시트 repo 로만)
 *  INV3 em.getRepository 는 StepNoteSheet 로만 불린다
 *  INV4 소스(주석 제거)에 식별자 `notes` 가 **아예 없다** — 이름을 안 부르면 못 쓴다
 *  INV5 소스에서 stepRepo 로 부르는 메서드는 findOne 뿐이다
 * ────────────────────────────────────────────────────────────────────────
 */
describe('StepNoteSheetsService', () => {
  let service: StepNoteSheetsService;
  let appRepo: jest.Mocked<Repository<Application>>;
  let stepRepo: jest.Mocked<Repository<ApplicationStep>>;
  let sheetRepo: jest.Mocked<Repository<StepNoteSheet>>;
  let dataSource: { transaction: jest.Mock };

  const USER_ID = 'user-1';
  const APP_ID = 'app-1';
  const STEP_ID = 'step-1';
  const NOW = new Date('2026-08-11T00:00:00Z');

  const makeApp = (): Application =>
    ({ id: APP_ID, userId: USER_ID }) as Application;

  const makeStep = (): ApplicationStep =>
    ({
      id: STEP_ID,
      applicationId: APP_ID,
      // 🔴 유산 노트 — 이 값이 어떤 경로로도 바뀌면 안 된다
      notes: '{"type":"doc","content":[]}',
    }) as ApplicationStep;

  const makeSheet = (o: Partial<StepNoteSheet> = {}): StepNoteSheet =>
    ({
      id: 'sheet-1',
      stepId: STEP_ID,
      name: '시트1',
      content: null,
      orderIndex: 0,
      createdAt: NOW,
      updatedAt: NOW,
      ...o,
    }) as StepNoteSheet;

  /** 시트 n장 생성 (order_index 0..n-1) */
  const makeSheets = (n: number): StepNoteSheet[] =>
    Array.from({ length: n }, (_, i) =>
      makeSheet({ id: `sheet-${i}`, name: `시트${i}`, orderIndex: i }),
    );

  /**
   * 트랜잭션 흉내 — **콜백이 throw 하면 그 안에서 쌓인 write 를 전부 버린다.**
   * 실 DB rollback 이 하는 일을 흉내 내야 C20(부분 저장 없음)을 볼 수 있다.
   * mock 이 write 를 그냥 통과시키면 롤백 테스트는 항상 통과해 아무것도 검증하지 못한다.
   */
  interface TxWorld {
    /** 트랜잭션 시작 시점의 시트 */
    sheets: StepNoteSheet[];
    /** 커밋된 최종 상태 — 롤백되면 시작 시점 그대로 */
    committed: StepNoteSheet[];
    /** findOne(ApplicationStep) 이 요청한 lock mode (동시성 근거) */
    lockModes: (string | undefined)[];
    /** getRepository 가 요청한 엔티티 (불변식 INV3) */
    repoRequests: unknown[];
    /** save 가 실제로 불렸는가 (캡·멱등 위반 시 미호출 검증) */
    saveCalls: number;
    /** remove 가 실제로 불렸는가 */
    removeCalls: number;
    /** save 를 실패시킨다 (롤백 검증) */
    failOnSave: boolean;
    /** em 직접 쓰기 호출 기록 (불변식 INV2 — 비어 있어야 한다) */
    emWrites: string[];
    /** 트랜잭션이 열린 횟수 */
    opened: number;
    /** appRepo·stepRepo 대신 트랜잭션 안에서 돌려줄 값 */
    app: Application | null;
    step: ApplicationStep | null;
  }
  let tx: TxWorld;

  const sortSheets = (list: StepNoteSheet[]): StepNoteSheet[] =>
    [...list].sort(
      (a, b) =>
        a.orderIndex - b.orderIndex ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );

  const installTransaction = () => {
    dataSource.transaction.mockImplementation(
      async (cb: (em: EntityManager) => Promise<unknown>) => {
        tx.opened += 1;
        const staged = [...tx.sheets];

        const txSheetRepo = {
          find: async ({ where }: { where: { stepId: string } }) =>
            sortSheets(staged.filter((s) => s.stepId === where.stepId)),
          findOne: async ({
            where,
          }: {
            where: { id: string; stepId: string };
          }) =>
            staged.find(
              (s) => s.id === where.id && s.stepId === where.stepId,
            ) ?? null,
          count: async ({ where }: { where: { stepId: string } }) =>
            staged.filter((s) => s.stepId === where.stepId).length,
          create: (o: Partial<StepNoteSheet>) => ({ ...o }) as StepNoteSheet,
          save: async (e: StepNoteSheet) => {
            tx.saveCalls += 1;
            if (tx.failOnSave) throw new Error('INSERT 실패 (제약 위반 흉내)');
            const row = {
              ...e,
              id: `new-${staged.length}`,
              createdAt: NOW,
              updatedAt: NOW,
            };
            staged.push(row);
            return row;
          },
          remove: async (e: StepNoteSheet) => {
            tx.removeCalls += 1;
            const i = staged.findIndex((s) => s.id === e.id);
            if (i >= 0) staged.splice(i, 1);
            return e;
          },
        };

        const recordWrite = (name: string) =>
          jest.fn(() => {
            tx.emWrites.push(name);
            return Promise.resolve(undefined);
          });

        const em = {
          findOne: jest.fn(
            async (
              entity: unknown,
              options?: { lock?: { mode?: string } },
            ): Promise<unknown> => {
              if (entity === Application) return tx.app;
              if (entity === ApplicationStep) {
                tx.lockModes.push(options?.lock?.mode);
                return tx.step;
              }
              return null;
            },
          ),
          getRepository: (entity: unknown) => {
            tx.repoRequests.push(entity);
            return txSheetRepo;
          },
          // 🔴 불변식 감시 — 서비스가 em 으로 직접 쓰기를 하면 여기 기록된다
          save: recordWrite('save'),
          update: recordWrite('update'),
          delete: recordWrite('delete'),
          insert: recordWrite('insert'),
          remove: recordWrite('remove'),
          softDelete: recordWrite('softDelete'),
        } as unknown as EntityManager;

        const result = await cb(em); // throw 하면 staged 는 버려진다
        tx.committed = staged;
        return result;
      },
    );
  };

  beforeEach(async () => {
    appRepo = mock<Repository<Application>>();
    stepRepo = mock<Repository<ApplicationStep>>();
    sheetRepo = mock<Repository<StepNoteSheet>>();
    dataSource = { transaction: jest.fn() };

    tx = {
      sheets: [],
      committed: [],
      lockModes: [],
      repoRequests: [],
      saveCalls: 0,
      removeCalls: 0,
      failOnSave: false,
      emWrites: [],
      opened: 0,
      app: makeApp(),
      step: makeStep(),
    };
    installTransaction();

    appRepo.findOne.mockResolvedValue(makeApp());
    stepRepo.findOne.mockResolvedValue(makeStep());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StepNoteSheetsService,
        { provide: getRepositoryToken(Application), useValue: appRepo },
        { provide: getRepositoryToken(ApplicationStep), useValue: stepRepo },
        { provide: getRepositoryToken(StepNoteSheet), useValue: sheetRepo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(StepNoteSheetsService);
  });

  // ── list ──

  describe('list', () => {
    it('L1) order_index ASC · created_at ASC 로 조회', async () => {
      const rows = makeSheets(2);
      sheetRepo.find.mockResolvedValue(rows);

      const result = await service.list(USER_ID, APP_ID, STEP_ID);

      expect(result).toBe(rows);
      expect(sheetRepo.find).toHaveBeenCalledWith({
        where: { stepId: STEP_ID },
        order: { orderIndex: 'ASC', createdAt: 'ASC' },
      });
    });

    it('L2) 시트 0장 → 빈 배열 (가짜 시트 생성 없음)', async () => {
      sheetRepo.find.mockResolvedValue([]);

      await expect(service.list(USER_ID, APP_ID, STEP_ID)).resolves.toEqual([]);
      expect(sheetRepo.save).not.toHaveBeenCalled();
    });

    it('L3) 타 유저 카드 → 404 · step 조회조차 안 한다', async () => {
      appRepo.findOne.mockResolvedValue(null);

      await expect(service.list(USER_ID, APP_ID, STEP_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(stepRepo.findOne).not.toHaveBeenCalled();
      expect(sheetRepo.find).not.toHaveBeenCalled();
    });

    it('L4) IDOR — 다른 카드의 stepId → 404', async () => {
      stepRepo.findOne.mockResolvedValue(null);

      await expect(service.list(USER_ID, APP_ID, STEP_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(sheetRepo.find).not.toHaveBeenCalled();
    });
  });

  // ── create ──

  describe('create', () => {
    it('C1) 0장 → order_index 0 · name trim 저장', async () => {
      const { sheet, created } = await service.create(
        USER_ID,
        APP_ID,
        STEP_ID,
        {
          name: '  면접 준비  ',
          content: '{"type":"doc"}',
        },
      );

      expect(created).toBe(true);
      expect(sheet.name).toBe('면접 준비');
      expect(sheet.orderIndex).toBe(0);
      expect(sheet.content).toBe('{"type":"doc"}');
      expect(sheet.stepId).toBe(STEP_ID);
      expect(tx.committed).toHaveLength(1);
    });

    it('C2) 3장 있음 → order_index = max+1', async () => {
      tx.sheets = makeSheets(3);

      const { sheet } = await service.create(USER_ID, APP_ID, STEP_ID, {
        name: '새 시트',
      });

      expect(sheet.orderIndex).toBe(3);
    });

    it('C3) order_index 가 연속이 아님(0,5) → 6 (개수가 아니라 max 를 본다)', async () => {
      tx.sheets = [
        makeSheet({ id: 's0', orderIndex: 0 }),
        makeSheet({ id: 's5', orderIndex: 5 }),
      ];

      const { sheet } = await service.create(USER_ID, APP_ID, STEP_ID, {
        name: '새 시트',
      });

      expect(sheet.orderIndex).toBe(6);
    });

    it('C4) content 미전달 → null', async () => {
      const { sheet } = await service.create(USER_ID, APP_ID, STEP_ID, {
        name: '빈 시트',
      });

      expect(sheet.content).toBeNull();
    });

    it(`C5) 캡 경계 ${MAX_SHEETS_PER_STEP - 1} + 1 → OK`, async () => {
      tx.sheets = makeSheets(MAX_SHEETS_PER_STEP - 1);

      const { sheet } = await service.create(USER_ID, APP_ID, STEP_ID, {
        name: '10번째',
      });

      expect(sheet.orderIndex).toBe(MAX_SHEETS_PER_STEP - 1);
      expect(tx.committed).toHaveLength(MAX_SHEETS_PER_STEP);
    });

    it(`C6) 🔴 캡 경계 ${MAX_SHEETS_PER_STEP} + 1 → 400 · 문구에 숫자 · save 미호출`, async () => {
      tx.sheets = makeSheets(MAX_SHEETS_PER_STEP);

      await expect(
        service.create(USER_ID, APP_ID, STEP_ID, { name: '11번째' }),
      ).rejects.toThrow(
        new BadRequestException(
          `준비 노트 시트는 스텝당 ${MAX_SHEETS_PER_STEP}장까지예요 (현재 ${MAX_SHEETS_PER_STEP}장).`,
        ),
      );
      expect(tx.saveCalls).toBe(0);
    });

    it('C7) 이름 공백만 → 400 · 트랜잭션 자체를 안 연다', async () => {
      await expect(
        service.create(USER_ID, APP_ID, STEP_ID, { name: '   ' }),
      ).rejects.toThrow(BadRequestException);
      expect(tx.opened).toBe(0);
    });

    it('C8) 이름 빈 문자열 → 400', async () => {
      await expect(
        service.create(USER_ID, APP_ID, STEP_ID, { name: '' }),
      ).rejects.toThrow(
        new BadRequestException(
          `시트 이름은 공백을 뺀 1~${SHEET_NAME_MAX_CHARS}자로 입력해 주세요.`,
        ),
      );
    });

    it(`C9) 이름 ${SHEET_NAME_MAX_CHARS + 1}자 → 400`, async () => {
      await expect(
        service.create(USER_ID, APP_ID, STEP_ID, {
          name: 'ㄱ'.repeat(SHEET_NAME_MAX_CHARS + 1),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(tx.opened).toBe(0);
    });

    it(`C10) 이름 ${SHEET_NAME_MAX_CHARS}자 경계 → OK`, async () => {
      const name = 'ㄱ'.repeat(SHEET_NAME_MAX_CHARS);

      const { sheet } = await service.create(USER_ID, APP_ID, STEP_ID, {
        name,
      });

      expect(sheet.name).toBe(name);
    });

    it('C11) 앞뒤 공백 붙은 52자 → trim 후 50 → OK (trim 먼저)', async () => {
      const core = 'ㄱ'.repeat(SHEET_NAME_MAX_CHARS);

      const { sheet } = await service.create(USER_ID, APP_ID, STEP_ID, {
        name: ` ${core} `,
      });

      expect(sheet.name).toBe(core);
    });

    it('C12) ifEmpty=true · 0장 → 생성 · created=true', async () => {
      const { sheet, created } = await service.create(
        USER_ID,
        APP_ID,
        STEP_ID,
        {
          name: '노트',
          content: '{"legacy":true}',
          ifEmpty: true,
        },
      );

      expect(created).toBe(true);
      expect(sheet.content).toBe('{"legacy":true}');
      expect(tx.saveCalls).toBe(1);
    });

    it('C13) 🔴 ifEmpty=true · 1장 → 기존 시트 반환 · created=false · save 미호출 (승격 멱등)', async () => {
      const existing = makeSheet({ id: 'already', name: '기존' });
      tx.sheets = [existing];

      const { sheet, created } = await service.create(
        USER_ID,
        APP_ID,
        STEP_ID,
        {
          name: '노트',
          content: '{"legacy":true}',
          ifEmpty: true,
        },
      );

      expect(created).toBe(false);
      expect(sheet.id).toBe('already');
      expect(tx.saveCalls).toBe(0);
      expect(tx.committed).toHaveLength(1);
    });

    it('C14) ifEmpty=true · 여러 장 → order_index 가장 작은 시트를 돌려준다', async () => {
      tx.sheets = [
        makeSheet({ id: 'later', orderIndex: 2 }),
        makeSheet({ id: 'first', orderIndex: 0 }),
      ];

      const { sheet } = await service.create(USER_ID, APP_ID, STEP_ID, {
        name: '노트',
        ifEmpty: true,
      });

      expect(sheet.id).toBe('first');
    });

    it('C15) 🔴 ifEmpty=true · 캡 꽉참 → 400 아니라 첫 시트 (멱등 판정이 캡보다 먼저)', async () => {
      tx.sheets = makeSheets(MAX_SHEETS_PER_STEP);

      const { sheet, created } = await service.create(
        USER_ID,
        APP_ID,
        STEP_ID,
        {
          name: '노트',
          ifEmpty: true,
        },
      );

      expect(created).toBe(false);
      expect(sheet.id).toBe('sheet-0');
    });

    it('C16) ifEmpty 미전달 · 1장 → 그냥 생성 (일반 추가는 멱등이 아니다)', async () => {
      tx.sheets = [makeSheet()];

      const { created } = await service.create(USER_ID, APP_ID, STEP_ID, {
        name: '두 번째',
      });

      expect(created).toBe(true);
      expect(tx.committed).toHaveLength(2);
    });

    it('C17) 타 유저 → 404 · save 미호출', async () => {
      tx.app = null;

      await expect(
        service.create(USER_ID, APP_ID, STEP_ID, { name: '노트' }),
      ).rejects.toThrow(NotFoundException);
      expect(tx.saveCalls).toBe(0);
    });

    it('C18) IDOR — 다른 카드 stepId → 404', async () => {
      tx.step = null;

      await expect(
        service.create(USER_ID, APP_ID, STEP_ID, { name: '노트' }),
      ).rejects.toThrow(NotFoundException);
      expect(tx.saveCalls).toBe(0);
    });

    it('C19) 🔴 스텝 행을 pessimistic_write 로 잠근다 (동시 POST 직렬화)', async () => {
      await service.create(USER_ID, APP_ID, STEP_ID, { name: '노트' });

      expect(tx.lockModes).toEqual(['pessimistic_write']);
    });

    it('C20) 🔴 저장 실패 → 전체 롤백 (부분 저장 없음)', async () => {
      tx.sheets = makeSheets(2);
      tx.failOnSave = true;

      await expect(
        service.create(USER_ID, APP_ID, STEP_ID, { name: '노트' }),
      ).rejects.toThrow('INSERT 실패 (제약 위반 흉내)');
      expect(tx.committed).toEqual([]); // 커밋 자체가 없었다
    });

    it('C21) 캡·order·ifEmpty 판정과 INSERT 가 한 트랜잭션 안에서 (tx 밖 repo 미사용)', async () => {
      await service.create(USER_ID, APP_ID, STEP_ID, { name: '노트' });

      expect(tx.opened).toBe(1);
      expect(sheetRepo.find).not.toHaveBeenCalled();
      expect(sheetRepo.save).not.toHaveBeenCalled();
    });
  });

  // ── update ──

  describe('update', () => {
    /** 서비스가 **in-place 로 고치는** 그 객체 — save 도 같은 객체를 돌려준다 */
    let existingSheet: StepNoteSheet;

    beforeEach(() => {
      existingSheet = makeSheet({ content: '{"old":1}' });
      sheetRepo.findOne.mockResolvedValue(existingSheet);
      sheetRepo.save.mockResolvedValue(existingSheet);
    });

    it('U1) name 수정 (+ trim)', async () => {
      const result = await service.update(USER_ID, APP_ID, STEP_ID, 'sheet-1', {
        name: '  바뀐 이름  ',
      });

      expect(result.name).toBe('바뀐 이름');
    });

    it('U2) content 수정', async () => {
      const result = await service.update(USER_ID, APP_ID, STEP_ID, 'sheet-1', {
        content: '{"new":1}',
      });

      expect(result.content).toBe('{"new":1}');
    });

    it('U3) content 빈 문자열 → null', async () => {
      const result = await service.update(USER_ID, APP_ID, STEP_ID, 'sheet-1', {
        content: '',
      });

      expect(result.content).toBeNull();
    });

    it('U4) order_index 수정', async () => {
      const result = await service.update(USER_ID, APP_ID, STEP_ID, 'sheet-1', {
        orderIndex: 3,
      });

      expect(result.orderIndex).toBe(3);
    });

    it('U5) 미전달 필드는 불변', async () => {
      const result = await service.update(USER_ID, APP_ID, STEP_ID, 'sheet-1', {
        name: '이름만',
      });

      expect(result.content).toBe('{"old":1}');
      expect(result.orderIndex).toBe(0);
    });

    it('U6) name 공백만 → 400 · save 미호출', async () => {
      await expect(
        service.update(USER_ID, APP_ID, STEP_ID, 'sheet-1', { name: '  ' }),
      ).rejects.toThrow(BadRequestException);
      expect(sheetRepo.save).not.toHaveBeenCalled();
    });

    it(`U7) name ${SHEET_NAME_MAX_CHARS + 1}자 → 400`, async () => {
      await expect(
        service.update(USER_ID, APP_ID, STEP_ID, 'sheet-1', {
          name: 'ㄱ'.repeat(SHEET_NAME_MAX_CHARS + 1),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(sheetRepo.save).not.toHaveBeenCalled();
    });

    it('U8) 타 유저 → 404', async () => {
      appRepo.findOne.mockResolvedValue(null);

      await expect(
        service.update(USER_ID, APP_ID, STEP_ID, 'sheet-1', { name: 'x' }),
      ).rejects.toThrow(NotFoundException);
      expect(sheetRepo.findOne).not.toHaveBeenCalled();
    });

    it('U9) IDOR — 다른 step 의 sheetId → 404', async () => {
      stepRepo.findOne.mockResolvedValue(null);

      await expect(
        service.update(USER_ID, APP_ID, STEP_ID, 'sheet-1', { name: 'x' }),
      ).rejects.toThrow(NotFoundException);
      expect(sheetRepo.findOne).not.toHaveBeenCalled();
    });

    it('U10) 없는 sheetId → 404', async () => {
      sheetRepo.findOne.mockResolvedValue(null);

      await expect(
        service.update(USER_ID, APP_ID, STEP_ID, 'nope', { name: 'x' }),
      ).rejects.toThrow(NotFoundException);
      expect(sheetRepo.save).not.toHaveBeenCalled();
    });
  });

  // ── remove ──

  describe('remove', () => {
    it('D1) 2장 중 1장 삭제 → OK', async () => {
      tx.sheets = makeSheets(2);

      await service.remove(USER_ID, APP_ID, STEP_ID, 'sheet-0');

      expect(tx.removeCalls).toBe(1);
      expect(tx.committed.map((s) => s.id)).toEqual(['sheet-1']);
    });

    it('D2) 🔴 마지막 1장 → 400 · remove 미호출', async () => {
      tx.sheets = makeSheets(1);

      await expect(
        service.remove(USER_ID, APP_ID, STEP_ID, 'sheet-0'),
      ).rejects.toThrow(
        new BadRequestException('시트는 1장 이상 있어야 해요.'),
      );
      expect(tx.removeCalls).toBe(0);
    });

    it('D3) 없는 sheetId → 404 (마지막 1장 판정보다 먼저)', async () => {
      tx.sheets = makeSheets(1);

      await expect(
        service.remove(USER_ID, APP_ID, STEP_ID, 'nope'),
      ).rejects.toThrow(NotFoundException);
    });

    it('D4) 타 유저 → 404', async () => {
      tx.app = null;
      tx.sheets = makeSheets(2);

      await expect(
        service.remove(USER_ID, APP_ID, STEP_ID, 'sheet-0'),
      ).rejects.toThrow(NotFoundException);
      expect(tx.removeCalls).toBe(0);
    });

    it('D5) IDOR — 다른 step 의 sheetId → 404', async () => {
      tx.sheets = [makeSheet({ id: 'other', stepId: 'step-other' })];

      await expect(
        service.remove(USER_ID, APP_ID, STEP_ID, 'other'),
      ).rejects.toThrow(NotFoundException);
    });

    it('D6) 스텝 행 잠금 (동시 DELETE 가 0장을 못 만든다)', async () => {
      tx.sheets = makeSheets(2);

      await service.remove(USER_ID, APP_ID, STEP_ID, 'sheet-0');

      expect(tx.lockModes).toEqual(['pessimistic_write']);
    });
  });

  // ── 🔴 최상위 불변식 ──

  describe('🔴 불변식 — 이 서비스는 steps.notes 를 절대 갱신하지 않는다', () => {
    /** 주석·문자열을 걷어낸 서비스 소스 (식별자만 남긴다) */
    const serviceCode = readFileSync(
      join(__dirname, 'step-note-sheets.service.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    it('INV1) 모든 공개 메서드를 돌려도 stepRepo 쓰기 메서드 호출 0', async () => {
      tx.sheets = makeSheets(2);
      sheetRepo.find.mockResolvedValue(makeSheets(2));
      sheetRepo.findOne.mockResolvedValue(makeSheet());
      sheetRepo.save.mockResolvedValue(makeSheet());

      await service.list(USER_ID, APP_ID, STEP_ID);
      await service.create(USER_ID, APP_ID, STEP_ID, { name: '새 시트' });
      await service.update(USER_ID, APP_ID, STEP_ID, 'sheet-1', {
        name: '수정',
        content: '{"x":1}',
      });
      await service.remove(USER_ID, APP_ID, STEP_ID, 'sheet-0');

      expect(stepRepo.save).not.toHaveBeenCalled();
      expect(stepRepo.update).not.toHaveBeenCalled();
      expect(stepRepo.delete).not.toHaveBeenCalled();
      expect(stepRepo.remove).not.toHaveBeenCalled();
      expect(stepRepo.insert).not.toHaveBeenCalled();
      expect(stepRepo.upsert).not.toHaveBeenCalled();
      expect(stepRepo.softDelete).not.toHaveBeenCalled();
      expect(stepRepo.increment).not.toHaveBeenCalled();
      // appRepo 도 마찬가지 (카드 자체도 안 건드린다)
      expect(appRepo.save).not.toHaveBeenCalled();
      expect(appRepo.update).not.toHaveBeenCalled();
    });

    it('INV2) 트랜잭션 em 으로 직접 쓰기 호출 0 (시트 쓰기는 시트 repo 로만)', async () => {
      tx.sheets = makeSheets(2);

      await service.create(USER_ID, APP_ID, STEP_ID, { name: '새 시트' });
      await service.remove(USER_ID, APP_ID, STEP_ID, 'sheet-0');

      expect(tx.emWrites).toEqual([]);
    });

    it('INV3) em.getRepository 는 StepNoteSheet 로만 불린다', async () => {
      await service.create(USER_ID, APP_ID, STEP_ID, { name: '새 시트' });

      expect(tx.repoRequests).toEqual([StepNoteSheet]);
    });

    it('INV4) 소스(주석 제거)에 식별자 notes 가 아예 없다 — 이름을 안 부르면 못 쓴다', () => {
      expect(serviceCode).not.toMatch(/\bnotes\b/);
      expect(serviceCode).not.toMatch(/\bpinnedContent\b/);
    });

    it('INV5) 소스에서 stepRepo 로 부르는 메서드는 findOne 뿐이다', () => {
      const calls = serviceCode.match(/stepRepo\.(\w+)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      expect([...new Set(calls)]).toEqual(['stepRepo.findOne']);
    });

    it('INV6) 소스에서 ApplicationStep 은 읽기(findOne) 인자로만 등장한다', () => {
      // 쓰기 메서드의 첫 인자로 스텝 엔티티가 넘어가는 형태가 없어야 한다
      expect(serviceCode).not.toMatch(
        /\.(save|update|delete|insert|remove|upsert|softDelete|softRemove|increment|decrement)\(\s*ApplicationStep/,
      );
      expect(serviceCode.match(/findOne\(ApplicationStep/g)).toHaveLength(1);
    });
  });
});
