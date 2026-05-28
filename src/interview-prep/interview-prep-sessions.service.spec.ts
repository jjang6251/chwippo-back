import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import type { Repository, SelectQueryBuilder } from 'typeorm';
import { ActivityLog } from '../activity/entities/activity-log.entity';
import { Application } from '../applications/application.entity';
import { ApplicationCoverletter } from '../applications/application-coverletter.entity';
import { InterviewPrepSession } from './entities/interview-prep-session.entity';
import { InterviewPrepSessionsService } from './interview-prep-sessions.service';

/**
 * F6 PR 2 Phase 3 — InterviewPrepSessionsService spec.
 *
 * 시나리오 매트릭스 (plan S9.1):
 * - create: 정상 / 빈 array / interviewType 미지정 / 다른 user app / soft-deleted app / coverletter IDOR / coverletter 다른 app / log IDOR
 * - listByApplication: 정상 + 다른 user app NotFound + DESC 정렬
 * - findOne: 정상 / 다른 user / 없는 id + user_id strip 검증
 * - update: round / interviewType null / myMemo / 빈 dto / 다른 user
 * - remove: 정상 / 다른 user
 * - 같은 app·round 중복 허용 (Q1 결정)
 */
describe('InterviewPrepSessionsService', () => {
  let service: InterviewPrepSessionsService;
  let sessionRepo: jest.Mocked<Repository<InterviewPrepSession>>;
  let appRepo: jest.Mocked<Repository<Application>>;
  let clRepo: jest.Mocked<Repository<ApplicationCoverletter>>;
  let logRepo: jest.Mocked<Repository<ActivityLog>>;

  const USER_ID = 'user-1';
  const APP_ID = 'app-1';

  // QueryBuilder mocks
  const appQb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  } as unknown as jest.Mocked<SelectQueryBuilder<Application>> & {
    getOne: jest.Mock;
  };
  const clQb = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getCount: jest.fn(),
  } as unknown as jest.Mocked<SelectQueryBuilder<ApplicationCoverletter>> & {
    getCount: jest.Mock;
  };

  const makeApp = (overrides: Partial<Application> = {}): Application =>
    ({
      id: APP_ID,
      userId: USER_ID,
      companyName: '카카오',
      jobCategory: '백엔드',
      deletedAt: null,
      ...overrides,
    }) as Application;

  const makeSession = (
    overrides: Partial<InterviewPrepSession> = {},
  ): InterviewPrepSession =>
    ({
      id: 'sess-1',
      userId: USER_ID,
      applicationId: APP_ID,
      round: '1차',
      interviewType: null,
      coverletterIds: [],
      extraLogIds: [],
      myMemo: null,
      createdAt: new Date('2026-05-27T10:00:00Z'),
      updatedAt: new Date('2026-05-27T10:00:00Z'),
      ...overrides,
    }) as InterviewPrepSession;

  beforeEach(async () => {
    sessionRepo = mock<Repository<InterviewPrepSession>>();
    appRepo = mock<Repository<Application>>();
    clRepo = mock<Repository<ApplicationCoverletter>>();
    logRepo = mock<Repository<ActivityLog>>();

    // QueryBuilder 재초기화
    appQb.where.mockReturnThis();
    appQb.andWhere.mockReturnThis();
    appQb.getOne.mockReset().mockResolvedValue(makeApp());
    clQb.innerJoin.mockReturnThis();
    clQb.where.mockReturnThis();
    clQb.andWhere.mockReturnThis();
    clQb.getCount.mockReset().mockResolvedValue(0);

    appRepo.createQueryBuilder.mockReturnValue(appQb);
    clRepo.createQueryBuilder.mockReturnValue(clQb);

    sessionRepo.create.mockImplementation(
      (input) =>
        ({ ...(input as object), id: 'sess-new' }) as InterviewPrepSession,
    );
    sessionRepo.save.mockImplementation(
      async (s) =>
        ({
          ...(s as object),
          createdAt: new Date(),
          updatedAt: new Date(),
        }) as InterviewPrepSession,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InterviewPrepSessionsService,
        {
          provide: getRepositoryToken(InterviewPrepSession),
          useValue: sessionRepo,
        },
        { provide: getRepositoryToken(Application), useValue: appRepo },
        {
          provide: getRepositoryToken(ApplicationCoverletter),
          useValue: clRepo,
        },
        { provide: getRepositoryToken(ActivityLog), useValue: logRepo },
      ],
    }).compile();
    service = module.get<InterviewPrepSessionsService>(
      InterviewPrepSessionsService,
    );
  });

  // ── create ──
  describe('create', () => {
    it('정상: application 본인 + 빈 arrays → 저장 + 응답 user_id 노출 0', async () => {
      const r = await service.create(USER_ID, {
        applicationId: APP_ID,
        round: '1차',
      });
      expect(r.applicationId).toBe(APP_ID);
      expect(r.round).toBe('1차');
      expect(r.coverletterIds).toEqual([]);
      expect(r.extraLogIds).toEqual([]);
      // user_id strip 검증 — response 에 userId 키 없어야 함
      expect('userId' in r).toBe(false);
    });

    it('정상: coverletterIds/extraLogIds 명시 + IDOR batch 통과 → 저장', async () => {
      clQb.getCount.mockResolvedValueOnce(2); // 2개 모두 본인
      logRepo.count.mockResolvedValueOnce(3); // 3개 모두 본인
      const r = await service.create(USER_ID, {
        applicationId: APP_ID,
        round: '1차',
        coverletterIds: ['cl-1', 'cl-2'],
        extraLogIds: ['log-1', 'log-2', 'log-3'],
      });
      expect(r.coverletterIds).toEqual(['cl-1', 'cl-2']);
      expect(r.extraLogIds).toEqual(['log-1', 'log-2', 'log-3']);
    });

    it('interviewType 미지정 → null 저장', async () => {
      const r = await service.create(USER_ID, {
        applicationId: APP_ID,
        round: '1차',
      });
      expect(r.interviewType).toBeNull();
    });

    it('interviewType 명시 (technical) → 그대로 저장', async () => {
      const r = await service.create(USER_ID, {
        applicationId: APP_ID,
        round: '1차',
        interviewType: 'technical',
      });
      expect(r.interviewType).toBe('technical');
    });

    it('application 본인 아님 → NotFound (정보 누출 방지)', async () => {
      appQb.getOne.mockResolvedValueOnce(null);
      await expect(
        service.create(USER_ID, { applicationId: APP_ID, round: '1차' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('application soft-deleted → NotFound (deleted_at IS NULL 가드)', async () => {
      // getOne mock 이 null 반환 (실제 SQL 이 deleted_at IS NULL 추가)
      appQb.getOne.mockResolvedValueOnce(null);
      await expect(
        service.create(USER_ID, { applicationId: APP_ID, round: '1차' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('coverletterIds 중 다른 user/다른 app 섞임 (count mismatch) → Forbidden', async () => {
      clQb.getCount.mockResolvedValueOnce(1); // 2개 보냈는데 1개만 본인 app
      await expect(
        service.create(USER_ID, {
          applicationId: APP_ID,
          round: '1차',
          coverletterIds: ['cl-1', 'cl-other'],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('extraLogIds 중 다른 user log 섞임 → Forbidden', async () => {
      logRepo.count.mockResolvedValueOnce(2); // 3개 보냈는데 2개만 본인
      await expect(
        service.create(USER_ID, {
          applicationId: APP_ID,
          round: '1차',
          extraLogIds: ['log-1', 'log-2', 'log-other'],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('빈 coverletterIds[] → IDOR 검증 skip (불필요한 쿼리 안 함)', async () => {
      await service.create(USER_ID, {
        applicationId: APP_ID,
        round: '1차',
        coverletterIds: [],
      });
      expect(clQb.getCount).not.toHaveBeenCalled();
    });

    it('빈 extraLogIds[] → IDOR 검증 skip', async () => {
      await service.create(USER_ID, {
        applicationId: APP_ID,
        round: '1차',
        extraLogIds: [],
      });
      expect(logRepo.count).not.toHaveBeenCalled();
    });

    it('같은 application + 같은 round 두 번 생성 → 새 row 별도 (unique 제약 없음, Q1)', async () => {
      const r1 = await service.create(USER_ID, {
        applicationId: APP_ID,
        round: '1차',
      });
      const r2 = await service.create(USER_ID, {
        applicationId: APP_ID,
        round: '1차',
      });
      // 둘 다 새 entity 로 save 호출
      expect(sessionRepo.save).toHaveBeenCalledTimes(2);
      expect(r1.round).toBe('1차');
      expect(r2.round).toBe('1차');
    });
  });

  // ── listByApplication ──
  describe('listByApplication', () => {
    it('정상: 본인 application 의 모든 session (createdAt DESC)', async () => {
      sessionRepo.find.mockResolvedValueOnce([
        makeSession({ id: 's-2', round: '2차' }),
        makeSession({ id: 's-1', round: '1차' }),
      ]);
      const r = await service.listByApplication(USER_ID, APP_ID);
      expect(r).toHaveLength(2);
      expect(sessionRepo.find).toHaveBeenCalledWith({
        where: { applicationId: APP_ID, userId: USER_ID },
        order: { createdAt: 'DESC' },
      });
      // user_id strip
      r.forEach((s) => {
        expect('userId' in s).toBe(false);
      });
    });

    it('session 0건 → 빈 배열', async () => {
      sessionRepo.find.mockResolvedValueOnce([]);
      const r = await service.listByApplication(USER_ID, APP_ID);
      expect(r).toEqual([]);
    });

    it('다른 user application → NotFound', async () => {
      appQb.getOne.mockResolvedValueOnce(null);
      await expect(
        service.listByApplication(USER_ID, APP_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── findOne ──
  describe('findOne', () => {
    it('정상 + user_id strip', async () => {
      sessionRepo.findOne.mockResolvedValueOnce(makeSession());
      const r = await service.findOne(USER_ID, 'sess-1');
      expect(r.id).toBe('sess-1');
      expect('userId' in r).toBe(false);
    });

    it('다른 user → NotFound', async () => {
      sessionRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.findOne(USER_ID, 'sess-other'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('없는 id → NotFound', async () => {
      sessionRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne(USER_ID, 'missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ── update ──
  describe('update', () => {
    it('round 변경', async () => {
      sessionRepo.findOne.mockResolvedValueOnce(makeSession());
      const r = await service.update(USER_ID, 'sess-1', { round: '2차' });
      expect(r.round).toBe('2차');
    });

    it('interviewType null 로 변경 (clearing)', async () => {
      sessionRepo.findOne.mockResolvedValueOnce(
        makeSession({ interviewType: 'technical' }),
      );
      const r = await service.update(USER_ID, 'sess-1', {
        interviewType: null,
      });
      expect(r.interviewType).toBeNull();
    });

    it('myMemo autosave', async () => {
      sessionRepo.findOne.mockResolvedValueOnce(makeSession());
      const r = await service.update(USER_ID, 'sess-1', {
        myMemo: '강조 포인트 적기',
      });
      expect(r.myMemo).toBe('강조 포인트 적기');
    });

    it('빈 dto → 기존 값 유지', async () => {
      const orig = makeSession({ round: '1차', myMemo: '기존' });
      sessionRepo.findOne.mockResolvedValueOnce(orig);
      const r = await service.update(USER_ID, 'sess-1', {});
      expect(r.round).toBe('1차');
      expect(r.myMemo).toBe('기존');
    });

    it('다른 user session → NotFound', async () => {
      sessionRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.update(USER_ID, 'sess-other', { round: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── remove ──
  describe('remove', () => {
    it('정상: 본인 session hard delete (questions CASCADE)', async () => {
      const s = makeSession();
      sessionRepo.findOne.mockResolvedValueOnce(s);
      await service.remove(USER_ID, 'sess-1');
      expect(sessionRepo.remove).toHaveBeenCalledWith(s);
    });

    it('다른 user → NotFound', async () => {
      sessionRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.remove(USER_ID, 'sess-other'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
