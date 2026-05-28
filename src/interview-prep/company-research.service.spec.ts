import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import type { Repository, SelectQueryBuilder } from 'typeorm';
import { AbuserBanService } from '../ai/abuser-ban.service';
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
        { provide: LlmService, useValue: llm },
        { provide: QuotaCheckService, useValue: quotaCheck },
        { provide: AbuserBanService, useValue: abuserBan },
      ],
    }).compile();
    service = module.get<CompanyResearchService>(CompanyResearchService);
  });

  // ── fetchForSession — cache hit/miss ──
  describe('fetchForSession — cache 흐름', () => {
    it('cache hit + 유효 → hit_count++ + 캐시 반환 (LLM 호출 0)', async () => {
      const row = makeCacheRow({ hitCount: 5 });
      cacheQb.getOne.mockResolvedValueOnce(row);

      const r = await service.fetchForSession(USER_ID, SESSION_ID);

      expect(r.status).toBe('ok');
      expect(r.isCached).toBe(true);
      expect(r.research).toEqual({ businessSummary: '메신저·결제·모빌리티' });
      expect(llm.call).not.toHaveBeenCalled();
      // hit_count 증가
      expect(cacheRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ hitCount: 6 }),
      );
    });

    it('cache miss → LLM 호출 → upsert (90일 TTL)', async () => {
      cacheQb.getOne.mockResolvedValueOnce(null);
      llm.call.mockResolvedValue({
        status: 'ok',
        text: 'see https://ko.wikipedia.org/wiki/카카오 for details',
        json: {
          businessSummary: '메신저',
          coreValues: '책임감',
          visionMission: '연결',
          recentTrends: 'AI 강화',
          financials: '매출 ↑',
          competitors: '네이버',
          jobInsights: '백엔드 Go/Java',
          interviewKeywords: ['협업', '책임'],
        },
        promptTokens: 500,
        completionTokens: 300,
        costUsd: 0.03,
        latencyMs: 1500,
        callLogId: 'log-1',
        outputRedacted: false,
      });

      const r = await service.fetchForSession(USER_ID, SESSION_ID);

      expect(r.status).toBe('ok');
      expect(r.isCached).toBe(false);
      expect(r.research?.businessSummary).toBe('메신저');
      expect(r.sources).toContain('https://ko.wikipedia.org/wiki/카카오');
      // 90일 TTL upsert
      expect(cacheRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          companyName: '카카오', // 정규화 (이미 lowercase)
          jobCategory: '백엔드',
        }),
      );
    });

    it('cache expired → LLM 호출로 갱신', async () => {
      const expiredRow = makeCacheRow({
        expiresAt: new Date(Date.now() - 1000), // 1초 전 만료
      });
      cacheQb.getOne.mockResolvedValueOnce(expiredRow);
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '',
        json: {
          businessSummary: '신규 요약',
          coreValues: '',
          visionMission: '',
          recentTrends: '',
          financials: '',
          competitors: '',
          jobInsights: '',
          interviewKeywords: [],
        },
        promptTokens: 100,
        completionTokens: 100,
        costUsd: 0.01,
        latencyMs: 500,
        callLogId: 'log-2',
        outputRedacted: false,
      });

      const r = await service.fetchForSession(USER_ID, SESSION_ID);

      expect(r.status).toBe('ok');
      expect(r.research?.businessSummary).toBe('신규 요약');
      expect(llm.call).toHaveBeenCalled();
    });

    it('opt_out=true → 빈 응답 + 안내', async () => {
      cacheQb.getOne.mockResolvedValueOnce(
        makeCacheRow({ optOut: true, aiResearch: {} }),
      );

      const r = await service.fetchForSession(USER_ID, SESSION_ID);

      expect(r.status).toBe('opt_out');
      expect(r.reason).toContain('동의가 철회');
      expect(llm.call).not.toHaveBeenCalled();
    });

    it('LLM 빈 응답 → MISS_CACHE 60일 TTL 짧게 저장 (재시도 차단)', async () => {
      cacheQb.getOne.mockResolvedValueOnce(null);
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '',
        json: {
          businessSummary: '',
          coreValues: '',
          visionMission: '',
          recentTrends: '',
          financials: '',
          competitors: '',
          jobInsights: '',
          interviewKeywords: [],
        },
        promptTokens: 50,
        completionTokens: 10,
        costUsd: 0.001,
        latencyMs: 100,
        callLogId: 'log-empty',
        outputRedacted: false,
      });

      const r = await service.fetchForSession(USER_ID, SESSION_ID);
      expect(r.status).toBe('ok');
      // 빈 결과여도 cache 저장 (재시도 차단)
      const savedCall = cacheRepo.save.mock.calls[0][0] as CompanyResearchCache;
      const ttlMs = savedCall.expiresAt.getTime() - Date.now();
      expect(ttlMs).toBeLessThan(90 * 24 * 60 * 60 * 1000); // MISS_CACHE < CACHE_TTL
      expect(ttlMs).toBeGreaterThan(50 * 24 * 60 * 60 * 1000); // 약 60일
    });

    it('정규화 — 대소문자·공백 다른 입력은 같은 cache key', async () => {
      cacheQb.getOne.mockResolvedValueOnce(null);
      llm.call.mockResolvedValue({
        status: 'ok',
        text: '',
        json: {
          businessSummary: 'x',
          coreValues: '',
          visionMission: '',
          recentTrends: '',
          financials: '',
          competitors: '',
          jobInsights: '',
          interviewKeywords: [],
        },
        promptTokens: 10,
        completionTokens: 5,
        costUsd: 0,
        latencyMs: 50,
        callLogId: 'c',
        outputRedacted: false,
      });
      appRepo.findOne.mockResolvedValue(makeApp({ companyName: '  KAKAO  ' }));

      await service.fetchForSession(USER_ID, SESSION_ID);
      // save 시 정규화된 회사명으로 저장됨
      const savedCall = cacheRepo.save.mock.calls[0][0] as CompanyResearchCache;
      expect(savedCall.companyName).toBe('kakao');
    });

    it('sources 추출 — 화이트리스트 외 URL filter', async () => {
      cacheQb.getOne.mockResolvedValueOnce(null);
      llm.call.mockResolvedValue({
        status: 'ok',
        text: 'refs: https://ko.wikipedia.org/wiki/x and https://jobplanet.co.kr/companies/123 and https://random-site.com/page',
        json: {
          businessSummary: 'x',
          coreValues: '',
          visionMission: '',
          recentTrends: '',
          financials: '',
          competitors: '',
          jobInsights: '',
          interviewKeywords: [],
        },
        promptTokens: 10,
        completionTokens: 5,
        costUsd: 0,
        latencyMs: 50,
        callLogId: 'c',
        outputRedacted: false,
      });

      const r = await service.fetchForSession(USER_ID, SESSION_ID);
      // 화이트리스트 (ko.wikipedia.org) 만 통과. jobplanet, random-site 제거
      expect(r.sources).toEqual(['https://ko.wikipedia.org/wiki/x']);
    });
  });

  // ── 권한 / 존재 ──
  describe('권한 / 존재', () => {
    it('session 다른 user → NotFound', async () => {
      sessionRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.fetchForSession(USER_ID, SESSION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('application 없음 → NotFound', async () => {
      appRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.fetchForSession(USER_ID, SESSION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── quota ──
  describe('quota', () => {
    it('DAY_LIMIT → blocked + abuser ban 트리거 + audit row', async () => {
      cacheQb.getOne.mockResolvedValueOnce(null);
      quotaCheck.checkAndPrepare.mockResolvedValueOnce({
        blocked: true,
        code: 'DAY_LIMIT',
        reason: '오늘 한도 초과',
      });
      llm.call.mockResolvedValue({
        status: 'blocked_quota',
        text: null,
        errorMessage: 'day',
        callLogId: 'log-b',
      });

      const r = await service.fetchForSession(USER_ID, SESSION_ID);
      expect(r.status).toBe('blocked');
      expect(r.reason).toContain('오늘');
      expect(llm.call).toHaveBeenCalledWith(
        expect.objectContaining({
          preBlockedStatus: 'blocked_quota',
          preBlockedReason: expect.stringContaining('DAY_LIMIT'),
        }),
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(abuserBan.checkAndBan).toHaveBeenCalledWith(
        USER_ID,
        'company_research',
        1,
      );
    });

    it('FEATURE_DISABLED → blocked, abuser ban 미트리거', async () => {
      cacheQb.getOne.mockResolvedValueOnce(null);
      quotaCheck.checkAndPrepare.mockResolvedValueOnce({
        blocked: true,
        code: 'FEATURE_DISABLED',
        reason: '관리자에 의해 일시 중단',
      });
      llm.call.mockResolvedValue({
        status: 'blocked_quota',
        text: null,
        errorMessage: 'disabled',
        callLogId: 'log-b',
      });

      const r = await service.fetchForSession(USER_ID, SESSION_ID);
      expect(r.status).toBe('blocked');
      expect(abuserBan.checkAndBan).not.toHaveBeenCalled();
    });

    it('LLM error → blocked + 사용자 안내', async () => {
      cacheQb.getOne.mockResolvedValueOnce(null);
      llm.call.mockResolvedValue({
        status: 'error',
        text: null,
        errorMessage: 'rate limit',
        callLogId: 'log-e',
      });
      const r = await service.fetchForSession(USER_ID, SESSION_ID);
      expect(r.status).toBe('blocked');
      expect(r.reason).toContain('잠시 후');
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
