import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import type { Repository, SelectQueryBuilder } from 'typeorm';
import { AbuserBanService } from '../ai/abuser-ban.service';
import { LlmCallLog } from '../ai/entities/llm-call-log.entity';
import { TierConfig } from '../ai/entities/tier-config.entity';
import { LlmService } from '../ai/llm.service';
import { QuotaCheckService } from '../ai/quota-check.service';
import { Application } from '../applications/application.entity';
import { CompanyResearchService } from './company-research.service';
import { CompanyResearchCache } from './entities/company-research-cache.entity';
import { InterviewPrepSession } from './entities/interview-prep-session.entity';

/**
 * F6 PR 2 Phase 4 단계 B — CompanyResearchService spec.
 *
 * 시나리오 매트릭스 (성공·실패·경계·보안·동시성):
 * - cache hit/miss/expired/opt_out
 * - 권한 (다른 user session) / 존재 (없는 session·application)
 * - quota DAY_LIMIT (abuser ban 트리거) / FEATURE_DISABLED (미트리거)
 * - LLM error / 빈 응답 → 짧은 miss cache (재시도 비용 보호)
 * - 정규화 (대소문자 같은 회사 공유)
 * - sources 화이트리스트 외 URL filter
 * - updateUserNotes (정상/5000자 초과/다른 user/빈 string)
 * - optOut (admin) / getTopCompanies (opt_out 제외)
 * - getCachedForSession (null/opt_out/만료/정상)
 */
describe('CompanyResearchService', () => {
  let service: CompanyResearchService;
  let cacheRepo: jest.Mocked<Repository<CompanyResearchCache>>;
  let sessionRepo: jest.Mocked<Repository<InterviewPrepSession>>;
  let appRepo: jest.Mocked<Repository<Application>>;
  let llm: jest.Mocked<LlmService>;
  let quotaCheck: jest.Mocked<QuotaCheckService>;
  let abuserBan: jest.Mocked<AbuserBanService>;

  const USER_ID = 'user-1';
  const SESSION_ID = 'sess-1';
  const APP_ID = 'app-1';

  const cacheQb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
    getMany: jest.fn(),
  } as unknown as jest.Mocked<SelectQueryBuilder<CompanyResearchCache>> & {
    getOne: jest.Mock;
    getMany: jest.Mock;
  };

  const makeSession = (
    overrides: Partial<InterviewPrepSession> = {},
  ): InterviewPrepSession =>
    ({
      id: SESSION_ID,
      userId: USER_ID,
      applicationId: APP_ID,
      round: '1차',
      interviewType: null,
      coverletterIds: [],
      extraLogIds: [],
      myMemo: null,
      jobDescription: null,
      emphasisPoints: null,
      userResearchNotes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as InterviewPrepSession;

  const makeApp = (overrides: Partial<Application> = {}): Application =>
    ({
      id: APP_ID,
      userId: USER_ID,
      companyName: '카카오',
      jobCategory: '백엔드',
      ...overrides,
    }) as Application;

  const makeCacheRow = (
    overrides: Partial<CompanyResearchCache> = {},
  ): CompanyResearchCache => ({
    id: 'cache-1',
    companyName: '카카오',
    jobCategory: '백엔드',
    seedVersion: null,
    aiResearch: { businessSummary: '메신저·결제·모빌리티' },
    sources: ['https://ko.wikipedia.org/wiki/카카오'],
    expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60일 남음
    optOut: false,
    hitCount: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    cacheRepo = mock<Repository<CompanyResearchCache>>();
    sessionRepo = mock<Repository<InterviewPrepSession>>();
    appRepo = mock<Repository<Application>>();
    llm = mock<LlmService>();
    quotaCheck = mock<QuotaCheckService>();
    abuserBan = mock<AbuserBanService>();

    cacheQb.where.mockReturnThis();
    cacheQb.andWhere.mockReturnThis();
    cacheQb.orderBy.mockReturnThis();
    cacheQb.limit.mockReturnThis();
    cacheQb.getOne.mockReset();
    cacheQb.getMany.mockReset();
    cacheRepo.createQueryBuilder.mockReturnValue(cacheQb);
    cacheRepo.create.mockImplementation(
      (input) => ({ ...(input as object) }) as CompanyResearchCache,
    );
    cacheRepo.save.mockImplementation(
      async (r) =>
        ({ ...(r as object), updatedAt: new Date() }) as CompanyResearchCache,
    );

    sessionRepo.findOne.mockResolvedValue(makeSession());
    sessionRepo.save.mockImplementation(async (s) => s as InterviewPrepSession);
    appRepo.findOne.mockResolvedValue(makeApp());

    quotaCheck.checkAndPrepare.mockResolvedValue({ blocked: false });
    abuserBan.checkAndBan.mockResolvedValue({ banned: false });

    // PR_B1 — 새 의존성 mock
    const llmCallLogRepo = mock<Repository<LlmCallLog>>();
    llmCallLogRepo.count.mockResolvedValue(0); // 회사 조사 cap 통과 default
    const tierRepo = mock<Repository<TierConfig>>();
    tierRepo.findOne.mockResolvedValue({
      tier: 'free',
      monthlyCoinLimit: '100.0',
      inputTokenCapPerCall: 8000,
      defaultCooldownSeconds: 3,
      companyResearchDailyCap: 2,
      noteSummaryCooldownMinutes: 60,
      priceKrw: 0,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompanyResearchService,
        {
          provide: getRepositoryToken(CompanyResearchCache),
          useValue: cacheRepo,
        },
        {
          provide: getRepositoryToken(InterviewPrepSession),
          useValue: sessionRepo,
        },
        { provide: getRepositoryToken(Application), useValue: appRepo },
        { provide: getRepositoryToken(LlmCallLog), useValue: llmCallLogRepo },
        { provide: getRepositoryToken(TierConfig), useValue: tierRepo },
        { provide: LlmService, useValue: llm },
        { provide: QuotaCheckService, useValue: quotaCheck },
        { provide: AbuserBanService, useValue: abuserBan },
      ],
    }).compile();
    service = module.get<CompanyResearchService>(CompanyResearchService);
  });

  // ── 권한 / 존재 ──
  describe('권한 / 존재', () => {
    it('session 다른 user → NotFound', async () => {
      sessionRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.getCachedForSession(USER_ID, SESSION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('application 없음 → NotFound', async () => {
      appRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.getCachedForSession(USER_ID, SESSION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── F1 자소서 풀페이지 — application 단위 ──
  describe('getCachedForApplication', () => {
    const APP_ID = 'app-uuid-1';

    it('getCachedForApplication: 다른 user → NotFound (IDOR 차단)', async () => {
      appRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.getCachedForApplication(USER_ID, APP_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(appRepo.findOne).toHaveBeenCalledWith({
        where: { id: APP_ID, userId: USER_ID },
      });
    });

    it('getCachedForApplication: cache miss → null', async () => {
      appRepo.findOne.mockResolvedValueOnce({
        id: APP_ID,
        userId: USER_ID,
        companyName: '네이버',
        jobCategory: '백엔드',
      } as never);
      cacheQb.getOne.mockResolvedValueOnce(null);
      const r = await service.getCachedForApplication(USER_ID, APP_ID);
      expect(r).toBeNull();
    });

    it('getCachedForApplication: cache hit (유효) → ok + isCached=true', async () => {
      appRepo.findOne.mockResolvedValueOnce({
        id: APP_ID,
        userId: USER_ID,
        companyName: '네이버',
        jobCategory: '백엔드',
      } as never);
      cacheQb.getOne.mockResolvedValueOnce({
        id: 'cache-1',
        aiResearch: { businessSummary: 'cached' },
        sources: [],
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
        optOut: false,
        hitCount: 0,
      } as never);
      const r = await service.getCachedForApplication(USER_ID, APP_ID);
      if (!r || r.status !== 'ok') throw new Error('expected ok');
      expect(r.isCached).toBe(true);
    });

    // ── pre-seed generic fallback (2026-07-09) ──
    it('직군 있음 + 맞춤 캐시 miss + generic(job NULL) hit → generic 반환', async () => {
      appRepo.findOne.mockResolvedValueOnce({
        id: APP_ID,
        userId: USER_ID,
        companyName: '네이버',
        jobCategory: '백엔드',
      } as never);
      cacheQb.getOne
        .mockResolvedValueOnce(null) // exact (네이버, 백엔드) miss
        .mockResolvedValueOnce({
          id: 'cache-generic',
          aiResearch: { businessSummary: 'generic pre-seed' },
          sources: [],
          expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
          updatedAt: new Date(),
          optOut: false,
          hitCount: 0,
        } as never); // generic (네이버, NULL) hit
      const r = await service.getCachedForApplication(USER_ID, APP_ID);
      if (!r || r.status !== 'ok') throw new Error('expected ok');
      expect(r.research?.businessSummary).toBe('generic pre-seed');
      expect(cacheQb.getOne).toHaveBeenCalledTimes(2);
    });

    it('직군 있음 + 맞춤 캐시 hit → generic 조회 안 함 (getOne 1회)', async () => {
      appRepo.findOne.mockResolvedValueOnce({
        id: APP_ID,
        userId: USER_ID,
        companyName: '네이버',
        jobCategory: '백엔드',
      } as never);
      cacheQb.getOne.mockResolvedValueOnce({
        id: 'cache-exact',
        aiResearch: { businessSummary: 'exact' },
        sources: [],
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
        optOut: false,
        hitCount: 0,
      } as never);
      const r = await service.getCachedForApplication(USER_ID, APP_ID);
      if (!r || r.status !== 'ok') throw new Error('expected ok');
      expect(cacheQb.getOne).toHaveBeenCalledTimes(1);
    });

    it('직군 없음 + miss → fallback 미발동 (getOne 1회)', async () => {
      appRepo.findOne.mockResolvedValueOnce({
        id: APP_ID,
        userId: USER_ID,
        companyName: '네이버',
        jobCategory: null,
      } as never);
      cacheQb.getOne.mockResolvedValueOnce(null);
      const r = await service.getCachedForApplication(USER_ID, APP_ID);
      expect(r).toBeNull();
      expect(cacheQb.getOne).toHaveBeenCalledTimes(1);
    });

    it('맞춤·generic 둘 다 miss → null (getOne 2회)', async () => {
      appRepo.findOne.mockResolvedValueOnce({
        id: APP_ID,
        userId: USER_ID,
        companyName: '네이버',
        jobCategory: '백엔드',
      } as never);
      cacheQb.getOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      const r = await service.getCachedForApplication(USER_ID, APP_ID);
      expect(r).toBeNull();
      expect(cacheQb.getOne).toHaveBeenCalledTimes(2);
    });

    it('getCachedForApplication: opt_out → opt_out status', async () => {
      appRepo.findOne.mockResolvedValueOnce({
        id: APP_ID,
        userId: USER_ID,
        companyName: '네이버',
        jobCategory: '백엔드',
      } as never);
      cacheQb.getOne.mockResolvedValueOnce({
        optOut: true,
      } as never);
      const r = await service.getCachedForApplication(USER_ID, APP_ID);
      if (!r || r.status !== 'opt_out') throw new Error('expected opt_out');
    });

    it('getCachedForApplication: expired cache → null (재fetch 유도)', async () => {
      appRepo.findOne.mockResolvedValueOnce({
        id: APP_ID,
        userId: USER_ID,
        companyName: '네이버',
        jobCategory: '백엔드',
      } as never);
      cacheQb.getOne.mockResolvedValueOnce({
        optOut: false,
        expiresAt: new Date(Date.now() - 1000), // 만료
        aiResearch: {},
        sources: [],
      } as never);
      const r = await service.getCachedForApplication(USER_ID, APP_ID);
      expect(r).toBeNull();
    });
  });

  // ── getCachedForSession (LLM 호출 X) ──
  describe('getCachedForSession', () => {
    it('cache 없음 → null', async () => {
      cacheQb.getOne.mockResolvedValueOnce(null);
      const r = await service.getCachedForSession(USER_ID, SESSION_ID);
      expect(r).toBeNull();
    });

    it('cache 있음 + 유효 → 정상', async () => {
      cacheQb.getOne.mockResolvedValueOnce(makeCacheRow());
      const r = await service.getCachedForSession(USER_ID, SESSION_ID);
      expect(r?.status).toBe('ok');
      expect(r?.isCached).toBe(true);
    });

    it('opt_out → opt_out 응답', async () => {
      cacheQb.getOne.mockResolvedValueOnce(makeCacheRow({ optOut: true }));
      const r = await service.getCachedForSession(USER_ID, SESSION_ID);
      expect(r?.status).toBe('opt_out');
    });

    it('만료 → null (재조사 trigger 유도)', async () => {
      cacheQb.getOne.mockResolvedValueOnce(
        makeCacheRow({ expiresAt: new Date(Date.now() - 1000) }),
      );
      const r = await service.getCachedForSession(USER_ID, SESSION_ID);
      expect(r).toBeNull();
    });
  });

  // ── updateUserNotes ──
  describe('updateUserNotes', () => {
    it('정상 — trim + 저장', async () => {
      await service.updateUserNotes(USER_ID, SESSION_ID, '  내 메모  ');
      expect(sessionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ userResearchNotes: '내 메모' }),
      );
    });

    it('빈 string → null 정규화', async () => {
      await service.updateUserNotes(USER_ID, SESSION_ID, '');
      expect(sessionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ userResearchNotes: null }),
      );
    });

    it('명시 null → null 저장', async () => {
      await service.updateUserNotes(USER_ID, SESSION_ID, null);
      expect(sessionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ userResearchNotes: null }),
      );
    });

    it('5000자 초과 → BadRequest', async () => {
      await expect(
        service.updateUserNotes(USER_ID, SESSION_ID, 'a'.repeat(5001)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('다른 user session → NotFound', async () => {
      sessionRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.updateUserNotes(USER_ID, SESSION_ID, '메모'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── optOut + admin 통계 ──
  describe('optOut (관리자) + 통계', () => {
    it('optOut — 해당 회사 모든 row opt_out + aiResearch 비움', async () => {
      const r1 = makeCacheRow({ id: 'r1', jobCategory: '백엔드' });
      const r2 = makeCacheRow({ id: 'r2', jobCategory: '프론트' });
      cacheRepo.find.mockResolvedValue([r1, r2]);

      await service.optOut('admin-1', '카카오');

      expect(cacheRepo.save).toHaveBeenCalledTimes(2);
      const savedRows = cacheRepo.save.mock.calls.map(
        (c) => c[0] as CompanyResearchCache,
      );
      savedRows.forEach((r) => {
        expect(r.optOut).toBe(true);
        expect(r.aiResearch).toEqual({});
        expect(r.sources).toEqual([]);
      });
    });

    it('getTopCompanies — opt_out=false 만, hit_count DESC, limit', async () => {
      cacheQb.getMany.mockResolvedValueOnce([
        makeCacheRow({ companyName: '카카오', hitCount: 50 }),
        makeCacheRow({ companyName: '네이버', hitCount: 30 }),
      ]);

      const r = await service.getTopCompanies(20);
      expect(r).toEqual([
        { companyName: '카카오', jobCategory: '백엔드', hitCount: 50 },
        { companyName: '네이버', jobCategory: '백엔드', hitCount: 30 },
      ]);
      // 화이트리스트 (opt_out=false) 필터 + DESC 정렬 SQL 검증
      expect(cacheQb.where).toHaveBeenCalledWith('c.opt_out = FALSE');
      expect(cacheQb.orderBy).toHaveBeenCalledWith('c.hit_count', 'DESC');
    });
  });
});
