import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import {
  DataSource,
  type EntityManager,
  type Repository,
  type SelectQueryBuilder,
} from 'typeorm';
import { BulkCreateQuestionsDto } from './dto/bulk-create-questions.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { InterviewPrepQuestion } from './entities/interview-prep-question.entity';
import { InterviewPrepSession } from './entities/interview-prep-session.entity';
import {
  InterviewPrepQuestionsService,
  MAX_CUSTOM_CHILDREN_PER_PARENT,
  MAX_CUSTOM_QUESTIONS_PER_SESSION,
  QUESTION_SOURCE_AI,
  QUESTION_SOURCE_USER,
  type QuestionNode,
} from './interview-prep-questions.service';
import { InterviewPrepSessionsService } from './interview-prep-sessions.service';

/**
 * F6 PR 2 Phase 3 — InterviewPrepQuestionsService spec.
 *
 * 시나리오 매트릭스 (plan S9.2):
 * - listTreeBySession: recursive CTE 결과 → 트리 구조 변환 (depth 0/1/2 + order_index)
 * - listTreeBySession: 다른 user session NotFound
 * - findOwnedRaw: 본인 / 다른 user / 없는 id
 * - update myMemo: 정상 / 빈 문자열 → null 정규화 / trim / 다른 user NotFound
 *   suggestedAnswer 변경은 DTO 에 필드 없음 → service spec 영역 X (DTO validation 책임)
 * - assertCanCreateFollowup: depth 0 OK / depth 1 OK / depth 2 → BadRequest / 다른 user → NotFound
 * - 빈 트리 (질문 0) → 빈 배열
 *
 * ────────────────────────────────────────────────────────────────────────
 * 질문 은행 D1 (2026-08-11) — 아래 시나리오를 **먼저 나열하고** 코드를 썼다.
 * 통과시키려고 짠 게 아니라 깨뜨리려고 짠 목록이다.
 *
 * ## bulkCreate
 *  B1  정상 1개 — source='user' · depth 0 · category 미지정은 null(미분류)
 *  B2  정상 50개 — 전부 저장 · order_index 가 배치 순서대로 연속
 *  B3  공백만("   ") → 400 (문구에 1~500 숫자)
 *  B4  501자 → 400
 *  B5  500자 경계 → OK
 *  B6  앞뒤 공백 붙은 502자 → trim 후 500 → OK (**trim 먼저** 근거)
 *  B7  타 유저·없는 세션 → 404 · 트랜잭션 자체를 안 연다
 *  B8  캡: 기존 커스텀 99 + 1 → OK (경계)
 *  B9  캡: 기존 커스텀 100 + 1 → 400 (경계 바로 밖) · save 미호출
 *  B10 캡: 기존 99 + 2 → 400 (배치를 **합산**해서 본다 — 1개씩 세면 뚫린다)
 *  B11 캡: AI 질문은 커스텀 캡에 안 센다 (AI 200 + 커스텀 1 → OK)
 *  B12 parent: 세션에 없는 id (타 유저·타 세션·없는 id) → 404
 *  B13 parent: AI 루트(depth 0, source='ai') → 400
 *  B14 parent: AI 루트의 depth-1 자식 → 400 (**walk-up** 으로 루트를 본다)
 *  B15 parent: user 루트(depth 0) → OK · depth 1
 *  B16 parent: user 루트의 depth-1 자식 → OK · depth 2 (walk-up 이 user 루트에 닿는다)
 *  B17 parent: depth 2 → 400 MAX_DEPTH_REACHED (자식이 3이 된다)
 *  B18 꼬리 캡: 기존 user 자식 9 + 1 → OK (경계)
 *  B19 꼬리 캡: 기존 user 자식 10 + 1 → 400
 *  B20 꼬리 캡: 기존 9 + 배치 2 → 400 (배치 합산)
 *  B21 꼬리 캡: AI 자식은 안 센다 (AI 자식 10 + user 1 → OK)
 *  B22 order_index: 빈 세션 → 0부터
 *  B23 order_index: 꼬리도 **세션 max+1** (부모별 max 가 아니다)
 *  B24 🔴 중간 실패 → **전체 롤백** (2번째 insert 실패 시 1번째도 안 남는다)
 *  B25 모든 write 가 트랜잭션 안에서 일어난다
 *
 * ## recordPractice
 *  P1  good·soso·again 3종 저장
 *  P2  🔴 last_practiced_at = **서버 시각** (고정 clock 과 일치)
 *  P3  타 유저 → 404 · save 미호출
 *  P4  응답에 lastPracticeResult·lastPracticedAt 가 실린다
 *  P5  두 번 평가하면 최신 것만 남는다 (이력 아님)
 *
 * ## remove
 *  D1  내 질문 삭제 OK
 *  D2  🔴 **AI 질문도 삭제 OK** (재생성 게이트 소멸로 금지 근거가 없어졌다)
 *  D3  타 유저 → 404 · remove 미호출
 *      (자손 동반 삭제는 FK ON DELETE CASCADE — 실 DB 를 쓰는 e2e 가 검증)
 *
 * ## update (PATCH 확장)
 *  U1  user 질문 questionText 수정 OK (+ trim)
 *  U2  user 질문 category 수정 OK
 *  U3  user 질문 category: null → 미분류로 되돌림
 *  U4  🔴 AI 질문 questionText → 400
 *  U5  🔴 AI 질문 category → **200** (2026-08-12 반전. 아래 근거)
 *  U5b 🔴 AI 질문 category: null 되돌리기도 200
 *  U6  🔴 AI 질문 myMemo → **여전히 OK** (기존 동작 불변)
 *  U7  AI 질문에 myMemo + questionText 동시 → 400 이고 myMemo 도 저장 안 됨
 *  U8  user 질문 questionText 501자 → 400
 *  U9  user 질문 questionText 공백만 → 400
 *  U10 🔴 **대응표** — 필드 × AI 질문 허용 (questionText ✗ / category ✓ / mustPrepare ✓ / myMemo ✓)
 *  U11 AI 질문에 category + questionText 동시 → 400 이고 category 도 저장 안 됨
 *
 * 🔴 **U5 는 원래 400 이었다** (2026-08-12 반전). AI 가 유형을 애매하게 붙였을 때
 * 사용자가 바로잡지 못하면 **흐름 정렬·시험 범위 필터 자체가 성립하지 않는다.**
 * `mustPrepare` 가 같은 논지로 먼저 전 질문 허용이 됐다 (「⭐만」 필터가 직접 추가
 * 질문에서 영원히 비면 안 된다). 유형은 "AI 가 만든 것" 의 정체성이 아니라 **내 분류**라
 * 본문과 축이 다르다 — 그래서 `questionText` 만 user 전용으로 남는다.
 *
 * ## 응답 필드 (저장은 되는데 안 실리는 사고 재발 방지)
 *  R1  source·lastPracticedAt·lastPracticeResult 가 트리 응답에 실린다
 *  R2  SQL 이 세 컬럼을 실제로 select 한다
 *  R3  옛 행(source 없음) → 'ai' 폴백
 * ────────────────────────────────────────────────────────────────────────
 */
describe('InterviewPrepQuestionsService', () => {
  let service: InterviewPrepQuestionsService;
  let questionRepo: jest.Mocked<Repository<InterviewPrepQuestion>>;
  let sessionsService: jest.Mocked<InterviewPrepSessionsService>;
  let dataSource: { query: jest.Mock; transaction: jest.Mock };

  const USER_ID = 'user-1';
  const SESSION_ID = 'sess-1';

  /**
   * 트랜잭션 흉내 — **콜백이 throw 하면 그 안에서 쌓인 write 를 전부 버린다.**
   * 실 DB rollback 이 하는 일을 그대로 흉내 내야 B24(부분 저장 없음)를 볼 수 있다.
   * mock 이 write 를 그냥 통과시키면 롤백 테스트가 항상 통과해 아무것도 검증하지 못한다.
   */
  interface TxWorld {
    /** 세션에 이미 있는 질문 (repo.find 가 돌려준다) */
    existing: InterviewPrepQuestion[];
    /** 커밋된 행 — 롤백되면 여기 안 들어온다 */
    committed: InterviewPrepQuestion[];
    /** N번째 entity 저장에서 실패시킨다 (1-based · 0 = 실패 없음) */
    failOnNthSave: number;
    /** save 가 실제로 불렸는가 (캡 위반 시 미호출 검증용) */
    saveCalls: number;
    /** 롤백 여부와 무관하게 **써진 적이 있는** 행 수 — 부분 쓰기가 실제로 일어났는지 확인용 */
    stagedEver: number;
  }
  let tx: TxWorld;

  const installTransaction = () => {
    dataSource.transaction.mockImplementation(
      async (cb: (em: EntityManager) => Promise<unknown>) => {
        const staged: InterviewPrepQuestion[] = [];
        const repo = {
          find: async (): Promise<InterviewPrepQuestion[]> => tx.existing,
          create: (o: Partial<InterviewPrepQuestion>): InterviewPrepQuestion =>
            ({ ...o }) as InterviewPrepQuestion,
          save: async (
            input: InterviewPrepQuestion | InterviewPrepQuestion[],
          ): Promise<InterviewPrepQuestion[]> => {
            tx.saveCalls += 1;
            const list = Array.isArray(input) ? input : [input];
            const out: InterviewPrepQuestion[] = [];
            list.forEach((e, i) => {
              if (tx.failOnNthSave && i + 1 === tx.failOnNthSave) {
                throw new Error('insert 실패 (DB 제약 위반 흉내)');
              }
              const row = {
                ...e,
                id: `new-${i}`,
                createdAt: new Date('2026-08-11T00:00:00Z'),
                updatedAt: new Date('2026-08-11T00:00:00Z'),
              };
              staged.push(row);
              tx.stagedEver += 1;
              out.push(row);
            });
            return out;
          },
        };
        const em = {
          getRepository: () => repo,
        } as unknown as EntityManager;

        const result = await cb(em); // throw 하면 staged 는 버려진다
        tx.committed.push(...staged);
        return result;
      },
    );
  };

  /** 세션에 이미 있는 질문 픽스처 (bulkCreate 의 `find` 가 select 하는 필드만) */
  const existingRow = (
    o: Partial<InterviewPrepQuestion> = {},
  ): InterviewPrepQuestion =>
    ({
      id: 'q-e',
      parentQuestionId: null,
      depth: 0,
      orderIndex: 0,
      source: QUESTION_SOURCE_AI,
      ...o,
    }) as InterviewPrepQuestion;

  const qQb = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  } as unknown as jest.Mocked<SelectQueryBuilder<InterviewPrepQuestion>> & {
    getOne: jest.Mock;
  };

  const makeQuestionEntity = (
    overrides: Partial<InterviewPrepQuestion> = {},
  ): InterviewPrepQuestion =>
    ({
      id: 'q-1',
      sessionId: SESSION_ID,
      parentQuestionId: null,
      depth: 0,
      orderIndex: 0,
      questionText: '자기소개',
      suggestedAnswer: '저는...',
      sourceLogIds: [],
      myMemo: null,
      createdAt: new Date('2026-05-27T10:00:00Z'),
      updatedAt: new Date('2026-05-27T10:00:00Z'),
      ...overrides,
    }) as InterviewPrepQuestion;

  beforeEach(async () => {
    questionRepo = mock<Repository<InterviewPrepQuestion>>();
    sessionsService = mock<InterviewPrepSessionsService>();
    dataSource = { query: jest.fn(), transaction: jest.fn() };
    tx = {
      existing: [],
      committed: [],
      failOnNthSave: 0,
      saveCalls: 0,
      stagedEver: 0,
    };
    installTransaction();

    qQb.innerJoin.mockReturnThis();
    qQb.where.mockReturnThis();
    qQb.andWhere.mockReturnThis();
    qQb.getOne.mockReset();
    questionRepo.createQueryBuilder.mockReturnValue(qQb);
    questionRepo.save.mockImplementation(
      async (q) => q as InterviewPrepQuestion,
    );
    sessionsService.findOwnedRaw.mockResolvedValue({
      id: SESSION_ID,
      userId: USER_ID,
    } as InterviewPrepSession);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InterviewPrepQuestionsService,
        {
          provide: getRepositoryToken(InterviewPrepQuestion),
          useValue: questionRepo,
        },
        {
          provide: InterviewPrepSessionsService,
          useValue: sessionsService,
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get<InterviewPrepQuestionsService>(
      InterviewPrepQuestionsService,
    );
  });

  // ── listTreeBySession ──
  describe('listTreeBySession', () => {
    it('정상: 트리 구조 변환 (main 2 + 각 main 의 follow-up 1) — 본인 session', async () => {
      // mock recursive CTE 결과
      dataSource.query.mockResolvedValueOnce([
        {
          id: 'q-m1',
          session_id: SESSION_ID,
          parent_question_id: null,
          depth: 0,
          order_index: 0,
          question_text: 'main 1',
          suggested_answer: 'ans 1',
          source_log_ids: ['log-1'],
          my_memo: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 'q-m2',
          session_id: SESSION_ID,
          parent_question_id: null,
          depth: 0,
          order_index: 1,
          question_text: 'main 2',
          suggested_answer: 'ans 2',
          source_log_ids: [],
          my_memo: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 'q-f1',
          session_id: SESSION_ID,
          parent_question_id: 'q-m1',
          depth: 1,
          order_index: 0,
          question_text: 'follow 1',
          suggested_answer: 'fans 1',
          source_log_ids: [],
          my_memo: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);

      const tree = await service.listTreeBySession(USER_ID, SESSION_ID);
      expect(tree).toHaveLength(2); // 2 main
      expect(tree[0].id).toBe('q-m1');
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children[0].id).toBe('q-f1');
      expect(tree[0].children[0].depth).toBe(1);
      expect(tree[1].id).toBe('q-m2');
      expect(tree[1].children).toHaveLength(0);
    });

    it('빈 트리 (질문 0) → 빈 배열', async () => {
      dataSource.query.mockResolvedValueOnce([]);
      const r = await service.listTreeBySession(USER_ID, SESSION_ID);
      expect(r).toEqual([]);
    });

    it('depth 2 트리 (main → follow → follow-of-follow)', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          id: 'q-m',
          session_id: SESSION_ID,
          parent_question_id: null,
          depth: 0,
          order_index: 0,
          question_text: 'main',
          suggested_answer: null,
          source_log_ids: [],
          my_memo: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 'q-f1',
          session_id: SESSION_ID,
          parent_question_id: 'q-m',
          depth: 1,
          order_index: 0,
          question_text: 'f1',
          suggested_answer: null,
          source_log_ids: [],
          my_memo: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 'q-f2',
          session_id: SESSION_ID,
          parent_question_id: 'q-f1',
          depth: 2,
          order_index: 0,
          question_text: 'f2 (of f1)',
          suggested_answer: null,
          source_log_ids: [],
          my_memo: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);

      const tree = await service.listTreeBySession(USER_ID, SESSION_ID);
      expect(tree).toHaveLength(1);
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children[0].children).toHaveLength(1);
      expect(tree[0].children[0].children[0].depth).toBe(2);
    });

    it('다른 user session → NotFound (sessionsService.findOwnedRaw 가드)', async () => {
      sessionsService.findOwnedRaw.mockRejectedValueOnce(
        new NotFoundException(),
      );
      await expect(
        service.listTreeBySession(USER_ID, 'sess-other'),
      ).rejects.toBeInstanceOf(NotFoundException);
      // CTE 쿼리 자체 실행 안 됨
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('source_log_ids 가 null/undefined → 빈 배열로 정규화', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          id: 'q-1',
          session_id: SESSION_ID,
          parent_question_id: null,
          depth: 0,
          order_index: 0,
          question_text: 'q',
          suggested_answer: null,
          source_log_ids: null, // DB row 가 null 인 경우
          my_memo: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
      const tree = await service.listTreeBySession(USER_ID, SESSION_ID);
      expect(tree[0].sourceLogIds).toEqual([]);
    });
  });

  // ── findOwnedRaw ──
  /**
   * 🔴 2026-08-07 회귀 — `category` 가 **저장은 되는데 응답에서 빠져 있었다.**
   *    프론트는 `CATEGORY_LABEL[question.category]` 로 태그 칩을 그리는데 값이 없어
   *    조건부 렌더가 항상 거짓이었다 — **태그가 한 번도 보인 적이 없다.**
   *    기존 spec 이 이걸 못 잡은 이유는 픽스처에 그 컬럼 자체가 없어서다
   *    (없는 필드는 서버가 담든 말든 똑같이 통과한다).
   */
  describe('응답 필드 — 화면이 쓰는 값이 실제로 실리는가', () => {
    it('🔴 category · mustPrepare 가 응답에 담긴다', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          id: 'q-1',
          session_id: SESSION_ID,
          parent_question_id: null,
          depth: 0,
          order_index: 0,
          category: 'coverletter_based',
          must_prepare: true,
          followup_basis: 'my_memo',
          question_text: 'q',
          suggested_answer: null,
          source_log_ids: [],
          my_memo: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
      const tree = await service.listTreeBySession(USER_ID, SESSION_ID);
      expect(tree[0].category).toBe('coverletter_based');
      expect(tree[0].mustPrepare).toBe(true);
      expect(tree[0].followupBasis).toBe('my_memo');
    });

    it('🔴 SQL 이 두 컬럼을 실제로 select 한다 — 매퍼만 고치면 항상 undefined 다', async () => {
      dataSource.query.mockResolvedValueOnce([]);
      await service.listTreeBySession(USER_ID, SESSION_ID);
      const sql = String(dataSource.query.mock.calls[0][0]);
      expect(sql).toContain('category');
      expect(sql).toContain('must_prepare');
      expect(sql).toContain('followup_basis');
    });

    it('옛 질문(컬럼 null·false) 도 안 깨진다', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          id: 'q-old',
          session_id: SESSION_ID,
          parent_question_id: null,
          depth: 0,
          order_index: 0,
          category: null,
          must_prepare: false,
          followup_basis: null,
          question_text: 'q',
          suggested_answer: null,
          source_log_ids: [],
          my_memo: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
      const tree = await service.listTreeBySession(USER_ID, SESSION_ID);
      expect(tree[0].category).toBeNull();
      expect(tree[0].mustPrepare).toBe(false);
      expect(tree[0].followupBasis).toBeNull();
    });
  });

  describe('findOwnedRaw', () => {
    it('정상: 본인 question 반환', async () => {
      qQb.getOne.mockResolvedValueOnce(makeQuestionEntity());
      const r = await service.findOwnedRaw(USER_ID, 'q-1');
      expect(r.id).toBe('q-1');
    });

    it('다른 user → NotFound (innerJoin s.user_id 가드)', async () => {
      qQb.getOne.mockResolvedValueOnce(null);
      await expect(
        service.findOwnedRaw(USER_ID, 'q-other'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('없는 id → NotFound', async () => {
      qQb.getOne.mockResolvedValueOnce(null);
      await expect(
        service.findOwnedRaw(USER_ID, 'missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── update (my_memo autosave) ──
  describe('update', () => {
    it('myMemo 정상 저장 + trim', async () => {
      qQb.getOne.mockResolvedValueOnce(makeQuestionEntity());
      const r = await service.update(USER_ID, 'q-1', {
        myMemo: '  내 답변  ',
      });
      expect(r.myMemo).toBe('내 답변');
    });

    it('myMemo 빈 문자열 → null 정규화', async () => {
      qQb.getOne.mockResolvedValueOnce(makeQuestionEntity({ myMemo: '기존' }));
      const r = await service.update(USER_ID, 'q-1', { myMemo: '' });
      expect(r.myMemo).toBeNull();
    });

    it('myMemo 공백만 → null 정규화', async () => {
      qQb.getOne.mockResolvedValueOnce(makeQuestionEntity());
      const r = await service.update(USER_ID, 'q-1', { myMemo: '   ' });
      expect(r.myMemo).toBeNull();
    });

    it('myMemo 명시적 null → null 저장', async () => {
      qQb.getOne.mockResolvedValueOnce(makeQuestionEntity({ myMemo: '기존' }));
      const r = await service.update(USER_ID, 'q-1', { myMemo: null });
      expect(r.myMemo).toBeNull();
    });

    it('빈 dto → 기존 값 유지 (save 는 호출됨 — 진정 dirty 검사는 ORM 영역)', async () => {
      qQb.getOne.mockResolvedValueOnce(makeQuestionEntity({ myMemo: '기존' }));
      const r = await service.update(USER_ID, 'q-1', {});
      expect(r.myMemo).toBe('기존');
    });

    it('다른 user → NotFound', async () => {
      qQb.getOne.mockResolvedValueOnce(null);
      await expect(
        service.update(USER_ID, 'q-other', { myMemo: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── assertCanCreateFollowup (depth 가드) ──
  describe('assertCanCreateFollowup', () => {
    it('parent.depth=0 → OK (자식 depth=1)', async () => {
      qQb.getOne.mockResolvedValueOnce(makeQuestionEntity({ depth: 0 }));
      const r = await service.assertCanCreateFollowup(USER_ID, 'q-1');
      expect(r.depth).toBe(0);
    });

    it('parent.depth=1 → OK (자식 depth=2)', async () => {
      qQb.getOne.mockResolvedValueOnce(makeQuestionEntity({ depth: 1 }));
      const r = await service.assertCanCreateFollowup(USER_ID, 'q-1');
      expect(r.depth).toBe(1);
    });

    it('parent.depth=2 → BadRequest (자식 depth=3 차단)', async () => {
      qQb.getOne.mockResolvedValueOnce(makeQuestionEntity({ depth: 2 }));
      await expect(
        service.assertCanCreateFollowup(USER_ID, 'q-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('다른 user parent → NotFound (depth 체크 전에 가드)', async () => {
      qQb.getOne.mockResolvedValueOnce(null);
      await expect(
        service.assertCanCreateFollowup(USER_ID, 'q-other'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 질문 은행 D1 (2026-08-11)
  // ══════════════════════════════════════════════════════════════════════

  // ── bulkCreate ──
  describe('bulkCreate — 내가 직접 적은 질문 넣기', () => {
    const call = (items: BulkCreateQuestionsDto['items'], sid = SESSION_ID) =>
      service.bulkCreate(USER_ID, sid, { items });

    it('B1 정상 1개 — source=user · depth 0 · 카테고리 미지정은 null(미분류)', async () => {
      const created = await call([{ questionText: '자기소개 해보세요' }]);

      expect(created).toHaveLength(1);
      expect(created[0].source).toBe(QUESTION_SOURCE_USER);
      expect(created[0].depth).toBe(0);
      expect(created[0].parentQuestionId).toBeNull();
      expect(created[0].questionText).toBe('자기소개 해보세요');
      // 🔴 'etc' 같은 새 값을 만들지 않는다 — 옛 질문의 미분류가 이미 null 이다
      expect(created[0].category).toBeNull();
      expect(tx.committed).toHaveLength(1);
    });

    it('B2 정상 50개 — 전부 저장 · order_index 가 배치 순서대로 연속', async () => {
      const items = Array.from({ length: 50 }, (_, i) => ({
        questionText: `질문 ${i + 1}`,
      }));
      const created = await call(items);

      expect(created).toHaveLength(50);
      expect(created.map((q) => q.orderIndex)).toEqual(
        Array.from({ length: 50 }, (_, i) => i),
      );
      expect(created[49].questionText).toBe('질문 50');
    });

    it('B3 공백만 → 400 · 문구에 1~500 숫자가 실린다', async () => {
      await expect(call([{ questionText: '   \n  ' }])).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(call([{ questionText: '   ' }])).rejects.toThrow(/1~500/);
      // DB 를 아예 안 만진다
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('B4 501자 → 400', async () => {
      await expect(
        call([{ questionText: '가'.repeat(501) }]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('B5 500자 경계 → OK', async () => {
      const created = await call([{ questionText: '가'.repeat(500) }]);
      expect(created[0].questionText).toHaveLength(500);
    });

    it('B6 앞뒤 공백 붙은 502자 → trim 후 500 → OK (trim 을 먼저 하는 이유)', async () => {
      const created = await call([{ questionText: ` ${'가'.repeat(500)} ` }]);
      expect(created[0].questionText).toHaveLength(500);
    });

    it('B7 타 유저·없는 세션 → 404 · 트랜잭션 자체를 안 연다', async () => {
      sessionsService.findOwnedRaw.mockRejectedValueOnce(
        new NotFoundException(),
      );
      await expect(
        call([{ questionText: '질문' }], 'sess-other'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('B8 캡 경계: 기존 커스텀 99 + 1 → OK', async () => {
      tx.existing = Array.from({ length: 99 }, (_, i) =>
        existingRow({ id: `c-${i}`, source: QUESTION_SOURCE_USER }),
      );
      const created = await call([{ questionText: '100번째' }]);
      expect(created).toHaveLength(1);
    });

    it('B9 캡 경계 밖: 기존 커스텀 100 + 1 → 400 · save 미호출', async () => {
      tx.existing = Array.from(
        { length: MAX_CUSTOM_QUESTIONS_PER_SESSION },
        (_, i) => existingRow({ id: `c-${i}`, source: QUESTION_SOURCE_USER }),
      );

      await expect(call([{ questionText: '101번째' }])).rejects.toThrow(/100/);
      expect(tx.saveCalls).toBe(0);
      expect(tx.committed).toHaveLength(0);
    });

    it('B10 캡은 배치를 합산해 본다 — 기존 99 + 배치 2 → 400', async () => {
      tx.existing = Array.from({ length: 99 }, (_, i) =>
        existingRow({ id: `c-${i}`, source: QUESTION_SOURCE_USER }),
      );
      await expect(
        call([{ questionText: 'a' }, { questionText: 'b' }]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('B11 AI 질문은 커스텀 캡에 안 센다 (AI 200 + 커스텀 1 → OK)', async () => {
      tx.existing = Array.from({ length: 200 }, (_, i) =>
        existingRow({ id: `a-${i}`, source: QUESTION_SOURCE_AI }),
      );
      const created = await call([{ questionText: '내 질문' }]);
      expect(created).toHaveLength(1);
    });

    it('B12 parent 가 이 세션에 없으면 (타 유저·타 세션·없는 id) → 404', async () => {
      tx.existing = [existingRow({ id: 'q-mine' })];
      await expect(
        call([{ questionText: '꼬리', parentQuestionId: 'q-남의것' }]),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.saveCalls).toBe(0);
    });

    it('B13 parent 가 AI 루트 → 400 (AI 트리엔 직접 꼬리를 못 단다)', async () => {
      tx.existing = [
        existingRow({ id: 'ai-root', depth: 0, source: QUESTION_SOURCE_AI }),
      ];
      await expect(
        call([{ questionText: '꼬리', parentQuestionId: 'ai-root' }]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('B14 🔴 parent 가 AI 루트의 depth-1 자식 → 400 (walk-up 으로 루트를 본다)', async () => {
      tx.existing = [
        existingRow({ id: 'ai-root', depth: 0, source: QUESTION_SOURCE_AI }),
        // 부모 자신은 source='user' 다 — **부모만 보면 통과해 버린다**
        existingRow({
          id: 'ai-child',
          depth: 1,
          parentQuestionId: 'ai-root',
          source: QUESTION_SOURCE_USER,
        }),
      ];
      await expect(
        call([{ questionText: '꼬리', parentQuestionId: 'ai-child' }]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('B15 parent 가 user 루트 → OK · depth 1', async () => {
      tx.existing = [
        existingRow({ id: 'my-root', depth: 0, source: QUESTION_SOURCE_USER }),
      ];
      const created = await call([
        { questionText: '꼬리', parentQuestionId: 'my-root' },
      ]);
      expect(created[0].depth).toBe(1);
      expect(created[0].parentQuestionId).toBe('my-root');
    });

    it('B16 parent 가 user 루트의 depth-1 자식 → OK · depth 2 (walk-up 이 user 루트에 닿는다)', async () => {
      tx.existing = [
        existingRow({ id: 'my-root', depth: 0, source: QUESTION_SOURCE_USER }),
        existingRow({
          id: 'ai-tail',
          depth: 1,
          parentQuestionId: 'my-root',
          // 부모는 AI 가 만든 꼬리지만 **루트가 내 질문**이라 허용된다
          source: QUESTION_SOURCE_AI,
        }),
      ];
      const created = await call([
        { questionText: '더 깊은 꼬리', parentQuestionId: 'ai-tail' },
      ]);
      expect(created[0].depth).toBe(2);
    });

    it('B17 parent.depth=2 → 400 MAX_DEPTH_REACHED (자식이 3이 된다)', async () => {
      tx.existing = [
        existingRow({ id: 'my-root', depth: 0, source: QUESTION_SOURCE_USER }),
        existingRow({
          id: 'd1',
          depth: 1,
          parentQuestionId: 'my-root',
          source: QUESTION_SOURCE_USER,
        }),
        existingRow({
          id: 'd2',
          depth: 2,
          parentQuestionId: 'd1',
          source: QUESTION_SOURCE_USER,
        }),
      ];
      await expect(
        call([{ questionText: '4단계', parentQuestionId: 'd2' }]),
      ).rejects.toThrow(/2단계/);
    });

    it('B18 꼬리 캡 경계: 기존 user 자식 9 + 1 → OK', async () => {
      tx.existing = [
        existingRow({ id: 'my-root', depth: 0, source: QUESTION_SOURCE_USER }),
        ...Array.from({ length: 9 }, (_, i) =>
          existingRow({
            id: `t-${i}`,
            depth: 1,
            parentQuestionId: 'my-root',
            source: QUESTION_SOURCE_USER,
          }),
        ),
      ];
      const created = await call([
        { questionText: '10번째 꼬리', parentQuestionId: 'my-root' },
      ]);
      expect(created).toHaveLength(1);
    });

    it('B19 꼬리 캡 밖: 기존 user 자식 10 + 1 → 400', async () => {
      tx.existing = [
        existingRow({ id: 'my-root', depth: 0, source: QUESTION_SOURCE_USER }),
        ...Array.from({ length: MAX_CUSTOM_CHILDREN_PER_PARENT }, (_, i) =>
          existingRow({
            id: `t-${i}`,
            depth: 1,
            parentQuestionId: 'my-root',
            source: QUESTION_SOURCE_USER,
          }),
        ),
      ];
      await expect(
        call([{ questionText: '11번째', parentQuestionId: 'my-root' }]),
      ).rejects.toThrow(/10/);
      expect(tx.saveCalls).toBe(0);
    });

    it('B20 꼬리 캡도 배치를 합산해 본다 — 기존 9 + 배치 2 → 400', async () => {
      tx.existing = [
        existingRow({ id: 'my-root', depth: 0, source: QUESTION_SOURCE_USER }),
        ...Array.from({ length: 9 }, (_, i) =>
          existingRow({
            id: `t-${i}`,
            depth: 1,
            parentQuestionId: 'my-root',
            source: QUESTION_SOURCE_USER,
          }),
        ),
      ];
      await expect(
        call([
          { questionText: 'a', parentQuestionId: 'my-root' },
          { questionText: 'b', parentQuestionId: 'my-root' },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('B21 꼬리 캡은 AI 자식을 안 센다 — 캡의 이유가 "공짜라서" 이기 때문', async () => {
      tx.existing = [
        existingRow({ id: 'my-root', depth: 0, source: QUESTION_SOURCE_USER }),
        ...Array.from({ length: MAX_CUSTOM_CHILDREN_PER_PARENT }, (_, i) =>
          existingRow({
            id: `ai-t-${i}`,
            depth: 1,
            parentQuestionId: 'my-root',
            source: QUESTION_SOURCE_AI,
          }),
        ),
      ];
      const created = await call([
        { questionText: '내 꼬리', parentQuestionId: 'my-root' },
      ]);
      expect(created).toHaveLength(1);
    });

    it('B22 order_index: 빈 세션이면 0부터', async () => {
      tx.existing = [];
      const created = await call([
        { questionText: 'a' },
        { questionText: 'b' },
      ]);
      expect(created.map((q) => q.orderIndex)).toEqual([0, 1]);
    });

    it('B23 order_index 는 꼬리도 세션 max+1 (부모별 max 가 아니다)', async () => {
      tx.existing = [
        existingRow({
          id: 'my-root',
          depth: 0,
          orderIndex: 7,
          source: QUESTION_SOURCE_USER,
        }),
      ];
      const created = await call([
        { questionText: '꼬리', parentQuestionId: 'my-root' },
      ]);
      expect(created[0].orderIndex).toBe(8);
    });

    it('B24 🔴 중간 실패 → 전체 롤백 (2번째 insert 가 깨지면 1번째도 안 남는다)', async () => {
      tx.failOnNthSave = 2;

      await expect(
        call([
          { questionText: '첫 번째' },
          { questionText: '두 번째' },
          { questionText: '세 번째' },
        ]),
      ).rejects.toThrow('insert 실패 (DB 제약 위반 흉내)');

      // 1번째는 **실제로 써졌다** — 아무것도 안 써졌다면 이 테스트는 롤백을 검증하지 못한다
      expect(tx.stagedEver).toBe(1);
      // 그런데도 커밋된 건 0 — 부분 저장이 남으면 사용자는 무엇이 들어갔는지 세어 봐야 하고
      // 재시도는 중복을 만든다
      expect(tx.committed).toHaveLength(0);
    });

    it('B25 모든 write 가 트랜잭션 안에서 일어난다 (repo 직접 save 경로 없음)', async () => {
      await call([{ questionText: '질문' }]);
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(questionRepo.save).not.toHaveBeenCalled();
    });

    it('화이트리스트 안의 category 는 그대로 저장된다', async () => {
      const created = await call([
        { questionText: '왜 우리 회사인가요', category: 'company_industry' },
      ]);
      expect(created[0].category).toBe('company_industry');
    });
  });

  // ── recordPractice ──
  describe('recordPractice — 「면접 보기」 자가평가', () => {
    const FIXED_NOW = new Date('2026-08-11T09:30:00.000Z');

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(FIXED_NOW);
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it.each(['good', 'soso', 'again'] as const)(
      'P1 %s 저장',
      async (result) => {
        qQb.getOne.mockResolvedValueOnce(makeQuestionEntity());
        const node = await service.recordPractice(USER_ID, 'q-1', result);
        expect(node.lastPracticeResult).toBe(result);
      },
    );

    it('P2 🔴 last_practiced_at 은 서버 시각 — 고정 clock 과 정확히 같다', async () => {
      qQb.getOne.mockResolvedValueOnce(makeQuestionEntity());
      const node = await service.recordPractice(USER_ID, 'q-1', 'good');
      expect(node.lastPracticedAt?.toISOString()).toBe(FIXED_NOW.toISOString());
    });

    it('P3 타 유저 → 404 · save 미호출', async () => {
      qQb.getOne.mockResolvedValueOnce(null);
      await expect(
        service.recordPractice(USER_ID, 'q-other', 'good'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(questionRepo.save).not.toHaveBeenCalled();
    });

    it('P4 응답에 두 값이 실린다 (저장만 되고 안 실리면 화면이 모른다)', async () => {
      qQb.getOne.mockResolvedValueOnce(makeQuestionEntity());
      const node = await service.recordPractice(USER_ID, 'q-1', 'again');
      expect(node).toEqual(
        expect.objectContaining({
          lastPracticeResult: 'again',
          lastPracticedAt: FIXED_NOW,
        }),
      );
    });

    it('P5 두 번 평가하면 최신 것만 남는다 (이력이 아니라 최신 1건)', async () => {
      const entity = makeQuestionEntity();
      qQb.getOne.mockResolvedValueOnce(entity);
      await service.recordPractice(USER_ID, 'q-1', 'again');
      qQb.getOne.mockResolvedValueOnce(entity);
      const node = await service.recordPractice(USER_ID, 'q-1', 'good');
      expect(node.lastPracticeResult).toBe('good');
    });
  });

  // ── remove ──
  describe('remove — 질문 삭제', () => {
    it('D1 내 질문 삭제 OK', async () => {
      const q = makeQuestionEntity({ source: QUESTION_SOURCE_USER });
      qQb.getOne.mockResolvedValueOnce(q);
      await service.remove(USER_ID, 'q-1');
      expect(questionRepo.remove).toHaveBeenCalledWith(q);
    });

    it('D2 🔴 AI 질문도 삭제 OK — 재생성 게이트가 사라져 금지 근거가 없다', async () => {
      const q = makeQuestionEntity({ source: QUESTION_SOURCE_AI });
      qQb.getOne.mockResolvedValueOnce(q);
      await expect(service.remove(USER_ID, 'q-1')).resolves.toBeUndefined();
      expect(questionRepo.remove).toHaveBeenCalledWith(q);
    });

    it('D3 타 유저 → 404 · remove 미호출', async () => {
      qQb.getOne.mockResolvedValueOnce(null);
      await expect(service.remove(USER_ID, 'q-other')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(questionRepo.remove).not.toHaveBeenCalled();
    });
  });

  // ── update 확장 (questionText · category) ──
  describe('update 확장 — 본문은 내 질문만 · 카테고리는 전 질문', () => {
    it('U1 user 질문 questionText 수정 OK (+ trim)', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({ source: QUESTION_SOURCE_USER }),
      );
      const node = await service.update(USER_ID, 'q-1', {
        questionText: '  고친 질문  ',
      });
      expect(node.questionText).toBe('고친 질문');
    });

    it('U2 user 질문 category 수정 OK', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({ source: QUESTION_SOURCE_USER }),
      );
      const node = await service.update(USER_ID, 'q-1', {
        category: 'failure',
      });
      expect(node.category).toBe('failure');
    });

    it('U3 category: null → 미분류로 되돌린다', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({
          source: QUESTION_SOURCE_USER,
          category: 'failure',
        }),
      );
      const node = await service.update(USER_ID, 'q-1', { category: null });
      expect(node.category).toBeNull();
    });

    it('U4 🔴 AI 질문 questionText 수정 → 400 (↻ 의 기준이 흐려진다)', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({ source: QUESTION_SOURCE_AI }),
      );
      await expect(
        service.update(USER_ID, 'q-1', { questionText: '몰래 고치기' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(questionRepo.save).not.toHaveBeenCalled();
    });

    /**
     * 🔴 **여기가 2026-08-12 에 뒤집힌 자리다** (전에는 400 이었다).
     *
     * AI 가 「왜 우리 회사인가요」에 `motivation` 이 아니라 `company_industry` 를 붙이는 식으로
     * 유형을 애매하게 매기는 일이 있는데, 그걸 사용자가 못 고치면 **흐름 정렬과 시험 범위
     * 필터가 근거를 잃는다** — 필터는 유형 값이 맞다는 전제 위에서만 쓸모가 있다.
     * `mustPrepare` 가 먼저 같은 논지로 열렸다. 유형은 정체성이 아니라 내 분류다.
     */
    it('U5 🔴 AI 질문도 category 는 고칠 수 있다 — 흐름 정렬·필터의 근거', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({
          source: QUESTION_SOURCE_AI,
          category: 'company_industry',
        }),
      );
      const node = await service.update(USER_ID, 'q-1', {
        category: 'motivation',
      });
      expect(node.category).toBe('motivation');
      expect(questionRepo.save).toHaveBeenCalled();
    });

    it('U5b 🔴 AI 질문 category: null → 미분류로 되돌리기도 된다', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({
          source: QUESTION_SOURCE_AI,
          category: 'company_industry',
        }),
      );
      const node = await service.update(USER_ID, 'q-1', { category: null });
      expect(node.category).toBeNull();
    });

    /**
     * ⭐ `mustPrepare` — **모든 질문에서 열려 있다** (D1b · D1a 판정 #4).
     *
     * 🔴 원래 LLM 전용 필드였다. 그 상태로 「⭐만」 필터를 내보내면 **직접 추가한
     * 질문에서는 영원히 빈 목록**이 나온다 — 은행의 중심이 「내가 모은 질문」인데
     * 우선순위를 못 매기는 셈이다. `questionText` 의 user 전용 제한과 성격이 다르다
     * (그건 "AI 가 만든 것" 의 정체성, 이건 내 준비 표시).
     * `category` 도 뒤이어 같은 논지로 열렸다 (U5 · U10 대응표).
     */
    it('M1 user 질문 mustPrepare 켜기 OK', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({
          source: QUESTION_SOURCE_USER,
          mustPrepare: false,
        }),
      );
      const node = await service.update(USER_ID, 'q-1', { mustPrepare: true });
      expect(node.mustPrepare).toBe(true);
    });

    it('M2 🔴 AI 질문 mustPrepare 도 켤 수 있다 (본문·카테고리 제한과 다른 축)', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({ source: QUESTION_SOURCE_AI, mustPrepare: false }),
      );
      const node = await service.update(USER_ID, 'q-1', { mustPrepare: true });
      expect(node.mustPrepare).toBe(true);
      expect(questionRepo.save).toHaveBeenCalled();
    });

    it('M3 끄기도 된다 (AI 가 켜둔 것을 내가 내릴 수 있어야 한다)', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({ source: QUESTION_SOURCE_AI, mustPrepare: true }),
      );
      const node = await service.update(USER_ID, 'q-1', { mustPrepare: false });
      expect(node.mustPrepare).toBe(false);
    });

    it('M4 🔴 AI 질문에 mustPrepare + questionText 동시 → 400 · mustPrepare 도 저장 안 된다', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({ source: QUESTION_SOURCE_AI, mustPrepare: false }),
      );
      await expect(
        service.update(USER_ID, 'q-1', {
          mustPrepare: true,
          questionText: '몰래 고치기',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(questionRepo.save).not.toHaveBeenCalled();
    });

    it('M5 user 질문은 mustPrepare + questionText 동시 수정 OK (조합)', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({
          source: QUESTION_SOURCE_USER,
          mustPrepare: false,
        }),
      );
      const node = await service.update(USER_ID, 'q-1', {
        mustPrepare: true,
        questionText: '고친 질문',
        category: 'failure',
      });
      expect(node.mustPrepare).toBe(true);
      expect(node.questionText).toBe('고친 질문');
      expect(node.category).toBe('failure');
    });

    it('M6 mustPrepare 미지정이면 기존 값을 건드리지 않는다', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({ source: QUESTION_SOURCE_AI, mustPrepare: true }),
      );
      const node = await service.update(USER_ID, 'q-1', { myMemo: '답변' });
      expect(node.mustPrepare).toBe(true);
    });

    it('U6 🔴 AI 질문 myMemo 는 여전히 OK — 기존 동작 불변', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({ source: QUESTION_SOURCE_AI }),
      );
      const node = await service.update(USER_ID, 'q-1', {
        myMemo: '내가 쓴 답변',
      });
      expect(node.myMemo).toBe('내가 쓴 답변');
    });

    it('U7 AI 질문에 myMemo + questionText 동시 → 400 이고 myMemo 도 저장 안 된다', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({ source: QUESTION_SOURCE_AI }),
      );
      await expect(
        service.update(USER_ID, 'q-1', {
          myMemo: '메모',
          questionText: '본문',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(questionRepo.save).not.toHaveBeenCalled();
    });

    it('U8 user 질문 questionText 501자 → 400', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({ source: QUESTION_SOURCE_USER }),
      );
      await expect(
        service.update(USER_ID, 'q-1', { questionText: '가'.repeat(501) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('U9 user 질문 questionText 공백만 → 400', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({ source: QUESTION_SOURCE_USER }),
      );
      await expect(
        service.update(USER_ID, 'q-1', { questionText: '   ' }),
      ).rejects.toThrow(/1~500/);
    });

    /**
     * U10 🔴 **필드 × 출처 대응표.** "AI 질문에서 무엇이 열려 있나" 를 한 표에 모은다.
     *
     * 개별 it 으로 흩어 두면 정책이 바뀔 때마다 **어디를 다 고쳐야 하는지**가 안 보이고,
     * 실제로 `category` 는 그렇게 흩어진 채 `questionText` 와 한 덩어리로 묶여 있었다.
     * 표로 두면 정책 변경 = 줄 하나 수정이고, 각 줄이 **왜 열렸/막혔는지**를 같이 들고 있어
     * 다음 사람이 "이건 왜 되고 저건 왜 안 되나" 를 추측하지 않는다.
     *
     * 축이 둘이다 — **정체성**(AI 가 만든 것인가: `questionText`)과 **내 것**(내 분류·내 준비
     * 표시·내 답변: 나머지 전부). 새 필드를 열 때 물어야 할 질문은 "user 전용인가" 가 아니라
     * "이 필드는 어느 축인가" 다.
     */
    const AI_PATCH_MATRIX: ReadonlyArray<{
      field: string;
      patch: UpdateQuestionDto;
      allowedOnAi: boolean;
      why: string;
      expect: (node: QuestionNode) => void;
    }> = [
      {
        field: 'questionText',
        patch: { questionText: '몰래 고치기' },
        allowedOnAi: false,
        why: '고치면 ↻(낱개 교체)가 무엇을 근거로 다시 뽑을지 사라진다 — 정체성 축',
        expect: () => undefined,
      },
      {
        field: 'category',
        patch: { category: 'motivation' },
        allowedOnAi: true,
        why: 'AI 가 유형을 애매하게 붙였을 때 못 고치면 흐름 정렬·시험 범위 필터가 성립하지 않는다',
        expect: (node) => expect(node.category).toBe('motivation'),
      },
      {
        field: 'mustPrepare',
        patch: { mustPrepare: true },
        allowedOnAi: true,
        why: '「⭐만」 필터가 직접 추가 질문에서 영원히 비면 안 된다 — 내 준비 표시 축',
        expect: (node) => expect(node.mustPrepare).toBe(true),
      },
      {
        field: 'myMemo',
        patch: { myMemo: '내가 쓴 답변' },
        allowedOnAi: true,
        why: '내 답변은 질문을 누가 만들었는지와 무관하다',
        expect: (node) => expect(node.myMemo).toBe('내가 쓴 답변'),
      },
    ];

    it.each(AI_PATCH_MATRIX)(
      'U10 대응표 — AI 질문 $field (허용=$allowedOnAi): $why',
      async ({ patch, allowedOnAi, expect: assertNode }) => {
        qQb.getOne.mockResolvedValueOnce(
          makeQuestionEntity({
            source: QUESTION_SOURCE_AI,
            category: 'company_industry',
            mustPrepare: false,
          }),
        );
        if (!allowedOnAi) {
          await expect(
            service.update(USER_ID, 'q-1', patch),
          ).rejects.toBeInstanceOf(BadRequestException);
          expect(questionRepo.save).not.toHaveBeenCalled();
          return;
        }
        const node = await service.update(USER_ID, 'q-1', patch);
        assertNode(node);
        expect(questionRepo.save).toHaveBeenCalled();
      },
    );

    /**
     * U11 — 열린 필드와 막힌 필드를 **한 요청에 섞으면 전부 무효**다.
     * 가드가 저장보다 먼저 서므로 부분 반영이 없다 (U7 의 myMemo 판과 같은 모양).
     */
    it('U11 AI 질문에 category + questionText 동시 → 400 이고 category 도 저장 안 된다', async () => {
      qQb.getOne.mockResolvedValueOnce(
        makeQuestionEntity({
          source: QUESTION_SOURCE_AI,
          category: 'company_industry',
        }),
      );
      await expect(
        service.update(USER_ID, 'q-1', {
          category: 'motivation',
          questionText: '몰래 고치기',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(questionRepo.save).not.toHaveBeenCalled();
    });
  });

  // ── 응답 필드 (질문 은행 3컬럼) ──
  describe('응답 필드 — 질문 은행 3컬럼이 실제로 실리는가', () => {
    it('R1·R2 트리 응답에 source·lastPracticedAt·lastPracticeResult 가 실리고 SQL 도 select 한다', async () => {
      const practicedAt = new Date('2026-08-10T12:00:00Z');
      dataSource.query.mockResolvedValueOnce([
        {
          id: 'q-1',
          session_id: SESSION_ID,
          parent_question_id: null,
          depth: 0,
          order_index: 0,
          category: null,
          must_prepare: false,
          followup_basis: null,
          question_text: '내가 받은 기출',
          suggested_answer: null,
          material_gap: null,
          source_log_ids: [],
          my_memo: null,
          source: QUESTION_SOURCE_USER,
          last_practiced_at: practicedAt,
          last_practice_result: 'again',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
      const tree = await service.listTreeBySession(USER_ID, SESSION_ID);
      expect(tree[0].source).toBe(QUESTION_SOURCE_USER);
      expect(tree[0].lastPracticedAt).toBe(practicedAt);
      expect(tree[0].lastPracticeResult).toBe('again');

      const sql = String(dataSource.query.mock.calls[0][0]);
      expect(sql).toContain('source');
      expect(sql).toContain('last_practiced_at');
      expect(sql).toContain('last_practice_result');
    });

    it('R3 옛 행(source 없음) → 안전하게 ai 로 읽는다', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          id: 'q-old',
          session_id: SESSION_ID,
          parent_question_id: null,
          depth: 0,
          order_index: 0,
          category: null,
          must_prepare: false,
          followup_basis: null,
          question_text: '옛 질문',
          suggested_answer: null,
          material_gap: null,
          source_log_ids: [],
          my_memo: null,
          source: null,
          last_practiced_at: null,
          last_practice_result: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
      const tree = await service.listTreeBySession(USER_ID, SESSION_ID);
      expect(tree[0].source).toBe(QUESTION_SOURCE_AI);
      expect(tree[0].lastPracticedAt).toBeNull();
      expect(tree[0].lastPracticeResult).toBeNull();
    });
  });
});
