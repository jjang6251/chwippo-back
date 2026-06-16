import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { DataSource, type Repository, type SelectQueryBuilder } from 'typeorm';
import { InterviewPrepQuestion } from './entities/interview-prep-question.entity';
import { InterviewPrepSession } from './entities/interview-prep-session.entity';
import { InterviewPrepQuestionsService } from './interview-prep-questions.service';
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
 */
describe('InterviewPrepQuestionsService', () => {
  let service: InterviewPrepQuestionsService;
  let questionRepo: jest.Mocked<Repository<InterviewPrepQuestion>>;
  let sessionsService: jest.Mocked<InterviewPrepSessionsService>;
  let dataSource: { query: jest.Mock };

  const USER_ID = 'user-1';
  const SESSION_ID = 'sess-1';

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
    dataSource = { query: jest.fn() };

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
});
