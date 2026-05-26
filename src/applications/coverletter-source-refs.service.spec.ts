import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import type { Repository, SelectQueryBuilder } from 'typeorm';
import { ActivityLog } from '../activity/entities/activity-log.entity';
import { ActivityReflection } from '../activity/entities/activity-reflection.entity';
import { Application } from './application.entity';
import { ApplicationCoverletter } from './application-coverletter.entity';
import { CoverletterSourceRef } from './coverletter-source-ref.entity';
import { CoverletterSourceRefsService } from './coverletter-source-refs.service';

/**
 * F6 PR 1 — CoverletterSourceRefsService spec.
 *
 * 시나리오 매트릭스:
 * - assertOwnsCoverletter: 본인 cl / 다른 user / 없는 id / soft-deleted app
 * - assertSelectedRefsBelongToUser (IDOR batch Critical #3):
 *   · 빈 배열 / 모두 본인 / 다른 cl 섞임 / source_log 가 다른 user / source_reflection 이 다른 user
 * - list: 본인 / 다른 user (NotFound)
 * - create: 정상 log / 정상 reflection / XOR 둘 다 / XOR 둘 다 미제공 / source 다른 user / 중복
 * - remove: 본인 / 없는 refId
 * - loadRefsWithSources: 매핑 / 빈 input
 * - bulkCreate: N개 정상 / 빈 배열 / save 일부 실패 (UNIQUE)
 */
describe('CoverletterSourceRefsService', () => {
  let service: CoverletterSourceRefsService;
  let appRepo: jest.Mocked<Repository<Application>>;
  let clRepo: jest.Mocked<Repository<ApplicationCoverletter>>;
  let refRepo: jest.Mocked<Repository<CoverletterSourceRef>>;
  let logRepo: jest.Mocked<Repository<ActivityLog>>;
  let reflRepo: jest.Mocked<Repository<ActivityReflection>>;
  let clQb: jest.Mocked<SelectQueryBuilder<ApplicationCoverletter>>;
  let refQb: jest.Mocked<SelectQueryBuilder<CoverletterSourceRef>>;

  const USER_ID = 'user-1';
  const OTHER_USER_ID = 'user-other';
  const CL_ID = 'cl-1';
  const APP_ID = 'app-1';

  const makeCl = (
    overrides: Partial<ApplicationCoverletter> = {},
  ): ApplicationCoverletter =>
    ({
      id: CL_ID,
      applicationId: APP_ID,
      question: '지원동기',
      category: '지원동기',
      answer: null,
      charLimit: 500,
      orderIndex: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as ApplicationCoverletter;

  const makeRef = (
    overrides: Partial<CoverletterSourceRef> = {},
  ): CoverletterSourceRef =>
    ({
      id: 'ref-1',
      coverletterId: CL_ID,
      sourceLogId: 'log-1',
      sourceReflectionId: null,
      snippetText: null,
      partialRange: null,
      aiRecommended: false,
      createdAt: new Date(),
      ...overrides,
    }) as CoverletterSourceRef;

  beforeEach(async () => {
    appRepo = mock<Repository<Application>>();
    clRepo = mock<Repository<ApplicationCoverletter>>();
    refRepo = mock<Repository<CoverletterSourceRef>>();
    logRepo = mock<Repository<ActivityLog>>();
    reflRepo = mock<Repository<ActivityReflection>>();

    // QueryBuilder mocks — chainable
    clQb = mock<SelectQueryBuilder<ApplicationCoverletter>>();
    clQb.innerJoin.mockReturnValue(clQb);
    clQb.where.mockReturnValue(clQb);
    clQb.andWhere.mockReturnValue(clQb);
    clRepo.createQueryBuilder.mockReturnValue(clQb);

    refQb = mock<SelectQueryBuilder<CoverletterSourceRef>>();
    refQb.innerJoin.mockReturnValue(refQb);
    refQb.where.mockReturnValue(refQb);
    refQb.andWhere.mockReturnValue(refQb);
    refRepo.createQueryBuilder.mockReturnValue(refQb);

    refRepo.create.mockImplementation((d) => d as CoverletterSourceRef);
    refRepo.save.mockImplementation(async (d) =>
      makeRef(d as Partial<CoverletterSourceRef>),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoverletterSourceRefsService,
        { provide: getRepositoryToken(Application), useValue: appRepo },
        {
          provide: getRepositoryToken(ApplicationCoverletter),
          useValue: clRepo,
        },
        {
          provide: getRepositoryToken(CoverletterSourceRef),
          useValue: refRepo,
        },
        { provide: getRepositoryToken(ActivityLog), useValue: logRepo },
        { provide: getRepositoryToken(ActivityReflection), useValue: reflRepo },
      ],
    }).compile();
    service = module.get<CoverletterSourceRefsService>(
      CoverletterSourceRefsService,
    );
  });

  // ── assertOwnsCoverletter ──
  describe('assertOwnsCoverletter (IDOR 1차 가드)', () => {
    it('본인 cl → 반환', async () => {
      clQb.getOne.mockResolvedValue(makeCl());
      const result = await service.assertOwnsCoverletter(USER_ID, CL_ID);
      expect(result.id).toBe(CL_ID);
    });

    it('다른 user 의 cl → NotFoundException (정보 누출 방지 — Forbidden 보다 NotFound)', async () => {
      clQb.getOne.mockResolvedValue(null);
      await expect(
        service.assertOwnsCoverletter(USER_ID, CL_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('없는 cl id → NotFoundException', async () => {
      clQb.getOne.mockResolvedValue(null);
      await expect(
        service.assertOwnsCoverletter(USER_ID, 'unknown'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── assertSelectedRefsBelongToUser ──
  describe('assertSelectedRefsBelongToUser (IDOR batch — Critical #3)', () => {
    it('빈 배열 → 빈 배열 반환, 쿼리 실행 안 함', async () => {
      const result = await service.assertSelectedRefsBelongToUser(
        USER_ID,
        CL_ID,
        [],
      );
      expect(result).toEqual([]);
      expect(refRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('모두 본인 ref (log 만 가리킴) → 반환 + 추가 log 검증 통과', async () => {
      const refs = [
        makeRef({ id: 'ref-1', sourceLogId: 'log-1' }),
        makeRef({ id: 'ref-2', sourceLogId: 'log-2' }),
      ];
      refQb.getMany.mockResolvedValue(refs);
      logRepo.count.mockResolvedValue(2);
      const result = await service.assertSelectedRefsBelongToUser(
        USER_ID,
        CL_ID,
        ['ref-1', 'ref-2'],
      );
      expect(result).toEqual(refs);
      expect(logRepo.count).toHaveBeenCalled();
    });

    it('refs 중 하나가 본인 cl 소속 아님 → count mismatch → ForbiddenException', async () => {
      // 요청은 3개인데 본인 cl 소속은 2개만 반환
      refQb.getMany.mockResolvedValue([
        makeRef({ id: 'ref-1' }),
        makeRef({ id: 'ref-2' }),
      ]);
      await expect(
        service.assertSelectedRefsBelongToUser(USER_ID, CL_ID, [
          'ref-1',
          'ref-2',
          'ref-3-other-user',
        ]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refs 자체는 OK 인데 source_log 가 다른 user → ForbiddenException (2차 가드)', async () => {
      refQb.getMany.mockResolvedValue([
        makeRef({ id: 'ref-1', sourceLogId: 'log-X' }),
      ]);
      // 본인 log 검증에서 0 반환 (다른 user 의 log)
      logRepo.count.mockResolvedValue(0);
      await expect(
        service.assertSelectedRefsBelongToUser(USER_ID, CL_ID, ['ref-1']),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refs 자체는 OK 인데 source_reflection 이 다른 user → ForbiddenException', async () => {
      refQb.getMany.mockResolvedValue([
        makeRef({
          id: 'ref-1',
          sourceLogId: null,
          sourceReflectionId: 'refl-X',
        }),
      ]);
      reflRepo.count.mockResolvedValue(0);
      await expect(
        service.assertSelectedRefsBelongToUser(USER_ID, CL_ID, ['ref-1']),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('log + reflection 혼합 — 둘 다 검증 통과 시 정상', async () => {
      refQb.getMany.mockResolvedValue([
        makeRef({ id: 'r1', sourceLogId: 'l1', sourceReflectionId: null }),
        makeRef({ id: 'r2', sourceLogId: null, sourceReflectionId: 'refl-1' }),
      ]);
      logRepo.count.mockResolvedValue(1);
      reflRepo.count.mockResolvedValue(1);
      const result = await service.assertSelectedRefsBelongToUser(
        USER_ID,
        CL_ID,
        ['r1', 'r2'],
      );
      expect(result).toHaveLength(2);
    });
  });

  // ── list ──
  describe('list', () => {
    it('본인 cl → ref 목록 반환', async () => {
      clQb.getOne.mockResolvedValue(makeCl());
      const refs = [makeRef(), makeRef({ id: 'ref-2' })];
      refRepo.find.mockResolvedValue(refs);
      const result = await service.list(USER_ID, CL_ID);
      expect(result).toEqual(refs);
    });

    it('다른 user cl → NotFoundException (assertOwnsCoverletter)', async () => {
      clQb.getOne.mockResolvedValue(null);
      await expect(service.list(OTHER_USER_ID, CL_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ── create ──
  describe('create', () => {
    beforeEach(() => {
      clQb.getOne.mockResolvedValue(makeCl());
    });

    it('정상 sourceLogId → save', async () => {
      logRepo.findOne.mockResolvedValue({
        id: 'log-1',
        userId: USER_ID,
      } as ActivityLog);
      refRepo.findOne.mockResolvedValue(null); // 중복 없음
      const result = await service.create(USER_ID, CL_ID, {
        sourceLogId: 'log-1',
      });
      expect(result.sourceLogId).toBe('log-1');
      expect(refRepo.save).toHaveBeenCalled();
    });

    it('정상 sourceReflectionId → save', async () => {
      reflRepo.findOne.mockResolvedValue({
        id: 'refl-1',
        userId: USER_ID,
      } as ActivityReflection);
      refRepo.findOne.mockResolvedValue(null);
      const result = await service.create(USER_ID, CL_ID, {
        sourceReflectionId: 'refl-1',
      });
      expect(result.sourceReflectionId).toBe('refl-1');
    });

    it('XOR 위반 (둘 다 제공) → BadRequestException', async () => {
      await expect(
        service.create(USER_ID, CL_ID, {
          sourceLogId: 'log-1',
          sourceReflectionId: 'refl-1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('XOR 위반 (둘 다 미제공) → BadRequestException', async () => {
      await expect(service.create(USER_ID, CL_ID, {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('source_log 가 다른 user → NotFoundException', async () => {
      logRepo.findOne.mockResolvedValue(null);
      await expect(
        service.create(USER_ID, CL_ID, { sourceLogId: 'log-X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('source_reflection 이 다른 user → NotFoundException', async () => {
      reflRepo.findOne.mockResolvedValue(null);
      await expect(
        service.create(USER_ID, CL_ID, { sourceReflectionId: 'refl-X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('중복 ref → BadRequestException (UNIQUE 사전 체크)', async () => {
      logRepo.findOne.mockResolvedValue({
        id: 'log-1',
        userId: USER_ID,
      } as ActivityLog);
      refRepo.findOne.mockResolvedValue(makeRef()); // 이미 존재
      await expect(
        service.create(USER_ID, CL_ID, { sourceLogId: 'log-1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('다른 user cl → NotFoundException (assertOwnsCoverletter)', async () => {
      clQb.getOne.mockResolvedValue(null);
      await expect(
        service.create(OTHER_USER_ID, CL_ID, { sourceLogId: 'log-1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── remove ──
  describe('remove', () => {
    it('본인 ref → 삭제', async () => {
      clQb.getOne.mockResolvedValue(makeCl());
      refRepo.findOne.mockResolvedValue(makeRef());
      await service.remove(USER_ID, CL_ID, 'ref-1');
      expect(refRepo.delete).toHaveBeenCalledWith({ id: 'ref-1' });
    });

    it('없는 refId → NotFoundException', async () => {
      clQb.getOne.mockResolvedValue(makeCl());
      refRepo.findOne.mockResolvedValue(null);
      await expect(
        service.remove(USER_ID, CL_ID, 'ref-X'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('다른 user cl → NotFoundException', async () => {
      clQb.getOne.mockResolvedValue(null);
      await expect(
        service.remove(OTHER_USER_ID, CL_ID, 'ref-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── loadRefsWithSources ──
  describe('loadRefsWithSources', () => {
    it('refs 가 log/reflection 가리킴 → 매핑 결과 반환', async () => {
      const refs = [
        makeRef({ id: 'r1', sourceLogId: 'l1' }),
        makeRef({ id: 'r2', sourceLogId: null, sourceReflectionId: 'refl1' }),
      ];
      const log = { id: 'l1' } as ActivityLog;
      const refl = { id: 'refl1' } as ActivityReflection;
      logRepo.find.mockResolvedValue([log]);
      reflRepo.find.mockResolvedValue([refl]);

      const result = await service.loadRefsWithSources(refs);
      expect(result.logs).toEqual([{ refId: 'r1', log }]);
      expect(result.reflections).toEqual([{ refId: 'r2', reflection: refl }]);
    });

    it('빈 refs → 빈 logs/reflections + repo 호출 0', async () => {
      const result = await service.loadRefsWithSources([]);
      expect(result.logs).toEqual([]);
      expect(result.reflections).toEqual([]);
      expect(logRepo.find).not.toHaveBeenCalled();
      expect(reflRepo.find).not.toHaveBeenCalled();
    });

    it('ref 가 가리키는 log 가 DB 에서 사라짐 → 매핑 결과에서 자연히 제외', async () => {
      const refs = [makeRef({ id: 'r1', sourceLogId: 'l-deleted' })];
      logRepo.find.mockResolvedValue([]); // log 없음
      const result = await service.loadRefsWithSources(refs);
      expect(result.logs).toEqual([]);
    });
  });

  // ── bulkCreate ──
  describe('bulkCreate', () => {
    it('빈 배열 → 빈 결과 + save 호출 0', async () => {
      const result = await service.bulkCreate(CL_ID, []);
      expect(result).toEqual([]);
      expect(refRepo.save).not.toHaveBeenCalled();
    });

    it('N개 정상 → 모두 save', async () => {
      const result = await service.bulkCreate(CL_ID, [
        { sourceLogId: 'l1', aiRecommended: true },
        { sourceReflectionId: 'r1', aiRecommended: true },
      ]);
      expect(result).toHaveLength(2);
      expect(refRepo.save).toHaveBeenCalledTimes(2);
    });

    it('save 중 일부 UNIQUE 충돌 → 성공한 것만 반환 (Promise.allSettled)', async () => {
      refRepo.save.mockReset();
      refRepo.save
        .mockResolvedValueOnce(makeRef({ id: 'new-1' }))
        .mockRejectedValueOnce(new Error('duplicate key'));
      const result = await service.bulkCreate(CL_ID, [
        { sourceLogId: 'l1', aiRecommended: true },
        { sourceLogId: 'l2', aiRecommended: true },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('new-1');
    });
  });
});
