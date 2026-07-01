import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { User } from './user.entity';
import { Application } from '../applications/application.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { UsersService } from './users.service';
import { StorageUsageService } from '../myinfo/storage-usage.service';
import { FilesService } from '../files/files.service';
import type { SignupAnswerDto } from './dto/signup-answer.dto';
import type { JobCategory } from './signup-job-categories.const';

describe('UsersService', () => {
  let service: UsersService;
  let userRepo: jest.Mocked<Repository<User>>;
  let storageUsage: jest.Mocked<StorageUsageService>;
  let filesService: jest.Mocked<FilesService>;
  let dataSource: jest.Mocked<DataSource>;
  let manager: jest.Mocked<EntityManager>;

  const makeUser = (overrides: Partial<User> = {}): User =>
    ({
      id: 'user-uuid-1',
      kakaoId: 'kakao-123',
      nickname: '테스트유저',
      email: null,
      role: 'user',
      refreshToken: null,
      lastActiveAt: null,
      createdAt: new Date(),
      ...overrides,
    }) as User;

  beforeEach(async () => {
    const mockRepo = mock<Repository<User>>();
    const mockStorage = mock<StorageUsageService>();
    const mockFiles = mock<FilesService>();
    mockStorage.collectAllFileUrls.mockResolvedValue([]);

    manager = mock<EntityManager>();
    manager.create.mockImplementation(
      (_target: unknown, input: unknown) => ({ ...(input as object) }) as never,
    );
    manager.save.mockImplementation(
      async (_target: unknown, input: unknown) => ({
        ...(input as object),
        id: 'app-' + Math.random().toString(36).slice(2, 8),
      }),
    );
    manager.update.mockResolvedValue({ affected: 1 } as never);

    dataSource = mock<DataSource>();
    dataSource.transaction.mockImplementation((cb: any) => cb(manager));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: mockRepo },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: StorageUsageService, useValue: mockStorage },
        { provide: FilesService, useValue: mockFiles },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    userRepo = module.get(getRepositoryToken(User));
    storageUsage = module.get(StorageUsageService);
    filesService = module.get(FilesService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── agreeTerms (LRR P2T1 PR N H-3) ────────────────────
  describe('agreeTerms', () => {
    it('정상: repo.update로 termsAgreedAt 갱신', async () => {
      userRepo.update.mockResolvedValue({} as any);
      await service.agreeTerms('user-uuid-1');
      expect(userRepo.update).toHaveBeenCalledWith(
        'user-uuid-1',
        expect.objectContaining({ termsAgreedAt: expect.any(Date) }),
      );
    });

    it('이미 동의한 user (idempotent) → 정상 호출 (timestamp 새 값으로 갱신)', async () => {
      userRepo.update.mockResolvedValue({} as any);
      await service.agreeTerms('user-uuid-1');
      // NotFound 검증 없음 — 단순 update. affected row 0이어도 throw 안 함
      expect(userRepo.update).toHaveBeenCalledTimes(1);
    });

    it('존재하지 않는 userId → throw 없이 update 호출 (affected 0, race 시점 약점)', async () => {
      userRepo.update.mockResolvedValue({ affected: 0 } as any);
      await expect(service.agreeTerms('nonexistent')).resolves.toBeUndefined();
    });
  });

  // ── markOnboarded (LRR P2T1 PR N H-3) ─────────────────
  describe('markOnboarded', () => {
    it('처음 호출 (onboardedAt null) → repo.update로 onboardedAt 설정', async () => {
      const user = makeUser({ onboardedAt: null });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.update.mockResolvedValue({} as any);

      await service.markOnboarded('user-uuid-1');

      expect(userRepo.findOneBy).toHaveBeenCalledWith({ id: 'user-uuid-1' });
      expect(userRepo.update).toHaveBeenCalledWith(
        'user-uuid-1',
        expect.objectContaining({ onboardedAt: expect.any(Date) }),
      );
    });

    it('이미 onboard됨 (onboardedAt 있음) → update 호출 안 함 (idempotent)', async () => {
      const user = makeUser({ onboardedAt: new Date('2026-01-01') });
      userRepo.findOneBy.mockResolvedValue(user);

      await service.markOnboarded('user-uuid-1');

      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('존재하지 않는 userId → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);
      await expect(service.markOnboarded('nonexistent')).rejects.toThrow(
        new NotFoundException('사용자를 찾을 수 없습니다.'),
      );
      expect(userRepo.update).not.toHaveBeenCalled();
    });
  });

  // ── updateNickname ─────────────────────────────────────
  describe('updateNickname', () => {
    it('존재하는 userId → 닉네임 변경 후 저장된 유저 반환', async () => {
      const user = makeUser();
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.save.mockImplementation(async (u) => u as User);

      const result = await service.updateNickname('user-uuid-1', '새닉네임');

      expect(userRepo.findOneBy).toHaveBeenCalledWith({ id: 'user-uuid-1' });
      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ nickname: '새닉네임' }),
      );
      expect(result.nickname).toBe('새닉네임');
    });

    it('존재하지 않는 userId → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.updateNickname('nonexistent', '닉네임'),
      ).rejects.toThrow(new NotFoundException('사용자를 찾을 수 없습니다.'));
      expect(userRepo.save).not.toHaveBeenCalled();
    });
  });

  // ── deleteAccount ──────────────────────────────────────
  describe('deleteAccount', () => {
    it('존재하는 userId → repo.remove 호출 (hard delete)', async () => {
      const user = makeUser();
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.remove.mockResolvedValue(user);

      await service.deleteAccount('user-uuid-1');

      expect(userRepo.findOneBy).toHaveBeenCalledWith({ id: 'user-uuid-1' });
      expect(userRepo.remove).toHaveBeenCalledWith(user);
    });

    it('softRemove가 아닌 remove 사용 확인', async () => {
      const user = makeUser();
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.remove.mockResolvedValue(user);

      await service.deleteAccount('user-uuid-1');

      expect(userRepo.remove).toHaveBeenCalled();
      expect((userRepo as any).softRemove).not.toHaveBeenCalled();
    });

    it('존재하지 않는 userId → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);
      await expect(service.deleteAccount('nonexistent')).rejects.toThrow(
        new NotFoundException('사용자를 찾을 수 없습니다.'),
      );
      expect(userRepo.remove).not.toHaveBeenCalled();
    });

    it('탈퇴 시 R2 파일 cascade 삭제 (E-6) — collectAllFileUrls 결과를 모두 deleteFile 호출', async () => {
      const user = makeUser();
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.remove.mockResolvedValue(user);
      storageUsage.collectAllFileUrls.mockResolvedValue([
        'r2://cert-1.pdf',
        'r2://award-1.jpg',
        'r2://doc-1.pdf',
      ]);

      await service.deleteAccount('user-uuid-1');

      // DB 삭제 → R2 cascade 순서 보장 (호출 순서 검증)
      expect(storageUsage.collectAllFileUrls).toHaveBeenCalledWith(
        'user-uuid-1',
      );
      const removeOrder = (userRepo.remove as jest.Mock).mock
        .invocationCallOrder[0];
      const firstDeleteOrder = (filesService.deleteFile as jest.Mock).mock
        .invocationCallOrder[0];
      expect(removeOrder).toBeLessThan(firstDeleteOrder);
      expect(filesService.deleteFile).toHaveBeenCalledTimes(3);
      expect(filesService.deleteFile).toHaveBeenCalledWith('r2://cert-1.pdf');
      expect(filesService.deleteFile).toHaveBeenCalledWith('r2://award-1.jpg');
      expect(filesService.deleteFile).toHaveBeenCalledWith('r2://doc-1.pdf');
    });

    it('파일 없는 유저 탈퇴 시 → deleteFile 미호출', async () => {
      const user = makeUser();
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.remove.mockResolvedValue(user);
      storageUsage.collectAllFileUrls.mockResolvedValue([]);

      await service.deleteAccount('user-uuid-1');

      expect(filesService.deleteFile).not.toHaveBeenCalled();
    });
  });

  // ── getDashboardConfig (LRR P2T1 PR O H-4) ────────────
  describe('getDashboardConfig', () => {
    it('DB dashboardConfig null → DEFAULT_SECTIONS (stats·dday·todos + W3 activity_streak·status_doughnut) 반환', async () => {
      const user = makeUser({ dashboardConfig: null });
      userRepo.findOneBy.mockResolvedValue(user);

      const result = await service.getDashboardConfig('user-uuid-1');

      expect(userRepo.findOneBy).toHaveBeenCalledWith({ id: 'user-uuid-1' });
      expect(result.sections).toEqual([
        { id: 'stats', visible: true },
        { id: 'dday', visible: true },
        { id: 'todos', visible: true },
        { id: 'activity_streak', visible: true },
        { id: 'status_doughnut', visible: true },
      ]);
    });

    it('W3 lazy merge — 기존 config 에 신규 섹션 (activity_streak·status_doughnut) 자동 append (visible:true)', async () => {
      const custom = {
        sections: [
          { id: 'stats', visible: true },
          { id: 'cover_letter_quick', visible: true },
        ],
      };
      const user = makeUser({ dashboardConfig: custom });
      userRepo.findOneBy.mockResolvedValue(user);

      const result = await service.getDashboardConfig('user-uuid-1');
      expect(result.sections).toEqual([
        { id: 'stats', visible: true },
        { id: 'cover_letter_quick', visible: true },
        // W3 신규 2개 lazy merge
        { id: 'activity_streak', visible: true },
        { id: 'status_doughnut', visible: true },
      ]);
    });

    it('기존 config 에 W3 신규 섹션 이미 있음 → 그대로 반환 (중복 append X)', async () => {
      const custom = {
        sections: [
          { id: 'stats', visible: true },
          { id: 'activity_streak', visible: false }, // 사용자가 toggle off 한 상태
          { id: 'status_doughnut', visible: true },
        ],
      };
      const user = makeUser({ dashboardConfig: custom });
      userRepo.findOneBy.mockResolvedValue(user);

      const result = await service.getDashboardConfig('user-uuid-1');
      expect(result).toEqual(custom);
    });

    it('존재하지 않는 userId → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);
      await expect(service.getDashboardConfig('nonexistent')).rejects.toThrow(
        new NotFoundException('사용자를 찾을 수 없습니다.'),
      );
    });

    it('orphan section ID 포함된 옛 DB row → 보존 (필터는 PATCH/프론트) + W3 lazy merge append', async () => {
      const orphan = {
        sections: [
          { id: 'stats', visible: true },
          { id: 'myinfo_progress', visible: true }, // ← deprecated 유지 (사용자 결정 존중)
          { id: 'dday', visible: true },
        ],
      };
      const user = makeUser({ dashboardConfig: orphan });
      userRepo.findOneBy.mockResolvedValue(user);

      const result = await service.getDashboardConfig('user-uuid-1');
      expect(result.sections).toEqual([
        { id: 'stats', visible: true },
        { id: 'myinfo_progress', visible: true },
        { id: 'dday', visible: true },
        // W3 lazy merge — 신규 2개 자동 append (orphan 보존과 별개)
        { id: 'activity_streak', visible: true },
        { id: 'status_doughnut', visible: true },
      ]);
    });
  });

  // ── updateDashboardConfig (LRR P2T1 PR O H-4) ─────────
  describe('updateDashboardConfig', () => {
    const validSections = [
      { id: 'stats', visible: true },
      { id: 'dday', visible: true },
      { id: 'todos', visible: false },
    ];

    it('정상 sections → 200 + DB JSONB 저장 + 응답', async () => {
      const user = makeUser({ dashboardConfig: null });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.save.mockImplementation(async (u) => u as User);

      const result = await service.updateDashboardConfig('user-uuid-1', {
        sections: validSections,
      });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          dashboardConfig: { sections: validSections },
        }),
      );
      expect(result.sections).toEqual(validSections);
    });

    it('sections[0].id !== "stats" → BadRequestException', async () => {
      const user = makeUser();
      userRepo.findOneBy.mockResolvedValue(user);

      await expect(
        service.updateDashboardConfig('user-uuid-1', {
          sections: [
            { id: 'dday', visible: true },
            { id: 'stats', visible: true },
          ],
        }),
      ).rejects.toThrow(
        new BadRequestException('stats 섹션은 항상 첫 번째여야 합니다.'),
      );
      expect(userRepo.save).not.toHaveBeenCalled();
    });

    it('sections [] → BadRequestException (sections[0] undefined → stats 첫 위치 enforce 실패)', async () => {
      const user = makeUser();
      userRepo.findOneBy.mockResolvedValue(user);

      await expect(
        service.updateDashboardConfig('user-uuid-1', { sections: [] }),
      ).rejects.toThrow(BadRequestException);
      expect(userRepo.save).not.toHaveBeenCalled();
    });

    it('존재하지 않는 userId → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.updateDashboardConfig('nonexistent', {
          sections: validSections,
        }),
      ).rejects.toThrow(new NotFoundException('사용자를 찾을 수 없습니다.'));
      expect(userRepo.save).not.toHaveBeenCalled();
    });
  });

  // ── countAll ───────────────────────────────────────────
  describe('countAll', () => {
    it('repo.count() 반환값을 그대로 반환', async () => {
      userRepo.count.mockResolvedValue(42);
      const result = await service.countAll();
      expect(result).toBe(42);
      expect(userRepo.count).toHaveBeenCalledTimes(1);
    });
  });

  // ── agreeAiConsent (Phase 5 — AI 사용 동의, PIPA 26조) ────
  describe('agreeAiConsent', () => {
    it('정상: 현재 버전으로 동의 → aiConsentAt + aiConsentVersion 갱신', async () => {
      const user = makeUser({ aiConsentAt: null, aiConsentVersion: null });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.update.mockResolvedValue({} as any);
      await service.agreeAiConsent('user-uuid-1', 'v1');
      expect(userRepo.update).toHaveBeenCalledWith(
        'user-uuid-1',
        expect.objectContaining({
          aiConsentAt: expect.any(Date),
          aiConsentVersion: 'v1',
        }),
      );
    });

    it('멱등: 이미 동의된 user 재호출 — timestamp 갱신', async () => {
      const user = makeUser({
        aiConsentAt: new Date('2025-01-01'),
        aiConsentVersion: 'v1',
      });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.update.mockResolvedValue({} as any);
      await service.agreeAiConsent('user-uuid-1', 'v1');
      expect(userRepo.update).toHaveBeenCalled();
    });

    it('wrong version → BadRequestException', async () => {
      await expect(
        service.agreeAiConsent('user-uuid-1', 'v999'),
      ).rejects.toThrow(BadRequestException);
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('없는 user → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.agreeAiConsent('user-unknown', 'v1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── withdrawAiConsent (Phase 5 — PIPA 26조 동등 보장) ────
  describe('withdrawAiConsent', () => {
    it('정상 철회 — aiConsentAt + aiConsentVersion 둘 다 NULL', async () => {
      const user = makeUser({
        aiConsentAt: new Date('2025-01-01'),
        aiConsentVersion: 'v1',
      });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.update.mockResolvedValue({} as any);
      await service.withdrawAiConsent('user-uuid-1');
      expect(userRepo.update).toHaveBeenCalledWith('user-uuid-1', {
        aiConsentAt: null,
        aiConsentVersion: null,
      });
    });

    it('멱등: 이미 철회된 user 재호출 OK (예외 X)', async () => {
      const user = makeUser({ aiConsentAt: null, aiConsentVersion: null });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.update.mockResolvedValue({} as any);
      await expect(
        service.withdrawAiConsent('user-uuid-1'),
      ).resolves.toBeUndefined();
    });

    it('없는 user → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);
      await expect(service.withdrawAiConsent('user-unknown')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── countByDate ────────────────────────────────────────
  describe('countByDate', () => {
    it('QueryBuilder getCount() 결과를 반환', async () => {
      const mockQb = {
        where: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(7),
      };
      userRepo.createQueryBuilder.mockReturnValue(mockQb as any);

      const from = new Date('2025-01-01');
      const result = await service.countByDate(from);

      expect(result).toBe(7);
      expect(mockQb.where).toHaveBeenCalledWith('u.created_at >= :from', {
        from,
      });
    });
  });

  // ── W1: signupAnswer + dismissAllSampleCards ─────────────
  // signup 1 질문 (관심 직군) 답변 → 가상 회사 샘플 카드 자동 생성 + 보드 dismiss.

  describe('signupAnswer (W1)', () => {
    const cat = (c: string): JobCategory => c as JobCategory;

    const makeDto = (
      overrides: Partial<SignupAnswerDto> = {},
    ): SignupAnswerDto => ({
      jobCategories: [cat('백엔드 개발')],
      ...overrides,
    });

    function mockSavedAppId() {
      // manager.save 가 sample 카드별 unique id 반환하도록 (step insert 시 applicationId)
      let counter = 0;
      manager.save.mockImplementation(async (_t: unknown, input: unknown) => ({
        ...(input as object),
        id: `app-${++counter}`,
      }));
    }

    it('정상 1개 직군 → users.update + 카드 1개 generate + 4 step', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer('user-uuid-1', makeDto());

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      // User update — signupJobCategories + onboardedAt set
      expect(manager.update).toHaveBeenCalledWith(
        User,
        'user-uuid-1',
        expect.objectContaining({
          signupJobCategories: ['백엔드 개발'],
          signupOtherText: null,
          onboardedAt: expect.any(Date),
        }),
      );
      // 카드 1개 (Application) + 4 step (ApplicationStep) save
      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      const stepSaves = manager.save.mock.calls.filter(
        (c) => c[0] === ApplicationStep,
      );
      expect(appSaves).toHaveLength(1);
      expect(stepSaves).toHaveLength(4);
      // Application — isSample true + currentStepIndex 0 + jobCategory 박제 + companyName
      expect(appSaves[0][1]).toMatchObject({
        userId: 'user-uuid-1',
        companyName: 'Cloud Tech 백엔드',
        jobCategory: '백엔드 개발',
        status: 'IN_PROGRESS',
        isSample: true,
        currentStepIndex: 0,
      });
    });

    it('정상 3개 직군 → 카드 3개 generate (각 직군 매칭)', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({
          jobCategories: [
            cat('백엔드 개발'),
            cat('UI/UX·프로덕트 디자이너'),
            cat('마케팅·광고'),
          ],
        }),
      );

      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves).toHaveLength(3);
      expect(appSaves[0][1]).toMatchObject({
        companyName: 'Cloud Tech 백엔드',
        currentStepIndex: 0,
      });
      expect(appSaves[1][1]).toMatchObject({
        companyName: 'Sunset Design UI/UX',
        currentStepIndex: 1,
      });
      expect(appSaves[2][1]).toMatchObject({
        companyName: 'Blue Marketing 퍼포먼스',
        currentStepIndex: 2,
      });
    });

    it('4개 직군 → 첫 3개만 카드 생성 (max 3)', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({
          jobCategories: [
            cat('백엔드 개발'),
            cat('프론트엔드 개발'),
            cat('모바일 앱 개발'),
            cat('데이터·AI'),
          ],
        }),
      );

      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves).toHaveLength(3);
    });

    it('21개 직군 → 첫 3개만 카드 생성', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      const all21: JobCategory[] = [
        '백엔드 개발',
        '프론트엔드 개발',
        '모바일 앱 개발',
        '데이터·AI',
        'DevOps·인프라·보안',
        'UI/UX·프로덕트 디자이너',
        '그래픽·브랜드 디자이너',
        '서비스 기획·PM',
        '콘텐츠·에디터·PR',
        '마케팅·광고',
        '영업·세일즈',
        '고객서비스·CS·CX',
        '인사·HR·노무',
        '재무·회계·세무',
        '법무·CPA·컴플라이언스',
        '경영기획·전략·컨설팅',
        '금융·은행·증권·보험',
        'R&D·연구개발',
        '의료·제약·바이오',
        '제조·생산·품질·SCM',
        '기타',
      ].map((c) => cat(c));

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({ jobCategories: all21 }),
      );

      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves).toHaveLength(3);
    });

    it('빈 array (건너뛰기) → 카드 0개 + signupJobCategories=[] 저장 + onboardedAt set', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );

      await service.signupAnswer('user-uuid-1', makeDto({ jobCategories: [] }));

      expect(manager.update).toHaveBeenCalledWith(
        User,
        'user-uuid-1',
        expect.objectContaining({
          signupJobCategories: [],
          signupOtherText: null,
          onboardedAt: expect.any(Date),
        }),
      );
      // 카드·step 둘 다 0개
      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves).toHaveLength(0);
    });

    it('"기타" + otherText="게임 기획" → "Sample Corp 게임 기획" 카드 + signupOtherText 저장', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({ jobCategories: [cat('기타')], otherText: '게임 기획' }),
      );

      expect(manager.update).toHaveBeenCalledWith(
        User,
        'user-uuid-1',
        expect.objectContaining({ signupOtherText: '게임 기획' }),
      );
      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves[0][1]).toMatchObject({
        companyName: 'Sample Corp 게임 기획',
        jobCategory: '게임 기획',
      });
    });

    it('"기타" + otherText 빈 string → "Sample Corp 신입" generic + signupOtherText=null', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({ jobCategories: [cat('기타')], otherText: '' }),
      );

      expect(manager.update).toHaveBeenCalledWith(
        User,
        'user-uuid-1',
        expect.objectContaining({ signupOtherText: null }),
      );
      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves[0][1]).toMatchObject({
        companyName: 'Sample Corp 신입',
        jobCategory: '기타',
      });
    });

    it('"기타" + otherText 공백만 → trim 후 빈 string → generic', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({ jobCategories: [cat('기타')], otherText: '   ' }),
      );

      expect(manager.update).toHaveBeenCalledWith(
        User,
        'user-uuid-1',
        expect.objectContaining({ signupOtherText: null }),
      );
      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves[0][1]).toMatchObject({
        companyName: 'Sample Corp 신입',
      });
    });

    it('"기타" 미선택 + otherText 있음 → 400 BadRequest', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );

      await expect(
        service.signupAnswer(
          'user-uuid-1',
          makeDto({ jobCategories: [cat('백엔드 개발')], otherText: '셰프' }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('이미 답변한 user (signupJobCategories not null) → 400', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: ['백엔드 개발'] }),
      );

      await expect(
        service.signupAnswer('user-uuid-1', makeDto()),
      ).rejects.toThrow(new BadRequestException('이미 답변하셨어요.'));
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('이미 답변한 user (빈 array, 건너뛰기) → 400 (빈 array 도 답변 완료)', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: [] }),
      );

      await expect(
        service.signupAnswer('user-uuid-1', makeDto()),
      ).rejects.toThrow(BadRequestException);
    });

    it('존재하지 않는 user → 404 NotFound', async () => {
      userRepo.findOneBy.mockResolvedValue(null);

      await expect(
        service.signupAnswer('nonexistent', makeDto()),
      ).rejects.toThrow(NotFoundException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('"기타" + otherText 미전송 (undefined) → generic, signupOtherText=null', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({ jobCategories: [cat('기타')] }), // otherText 없음
      );

      expect(manager.update).toHaveBeenCalledWith(
        User,
        'user-uuid-1',
        expect.objectContaining({ signupOtherText: null }),
      );
      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves[0][1]).toMatchObject({ companyName: 'Sample Corp 신입' });
    });

    it('백엔드 + 기타(셰프) hybrid → 카드 2개 (Cloud Tech 백엔드 + Sample Corp 셰프)', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({
          jobCategories: [cat('백엔드 개발'), cat('기타')],
          otherText: '셰프',
        }),
      );

      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves).toHaveLength(2);
      expect(appSaves[0][1]).toMatchObject({
        companyName: 'Cloud Tech 백엔드',
        jobCategory: '백엔드 개발',
        currentStepIndex: 0,
      });
      expect(appSaves[1][1]).toMatchObject({
        companyName: 'Sample Corp 셰프',
        jobCategory: '셰프',
        currentStepIndex: 1,
      });
    });

    it('카드 deadline 분산 — 카드별 첫 step 의 scheduledDate 가 today +7/+14/+21', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({
          jobCategories: [
            cat('백엔드 개발'),
            cat('UI/UX·프로덕트 디자이너'),
            cat('마케팅·광고'),
          ],
        }),
      );

      // 각 카드별 첫 step (orderIndex 0) 의 scheduledDate 확인
      const firstSteps = manager.save.mock.calls
        .filter((c) => c[0] === ApplicationStep)
        .filter((c) => (c[1] as { orderIndex: number }).orderIndex === 0);
      expect(firstSteps).toHaveLength(3);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      for (let i = 0; i < 3; i++) {
        const sched = (firstSteps[i][1] as { scheduledDate: Date })
          .scheduledDate;
        const expectedDays = (i + 1) * 7;
        const actualDays = Math.round(
          (sched.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
        );
        expect(actualDays).toBe(expectedDays);
      }
    });
  });

  describe('dismissAllSampleCards (W1)', () => {
    beforeEach(() => {
      // createQueryBuilder chain mock (mass UPDATE applications)
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 3 }),
      };
      manager.createQueryBuilder.mockReturnValue(qb as never);
    });

    it('정상 → users.sample_cards_dismissed_at set + applications mass soft delete', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ sampleCardsDismissedAt: null }),
      );

      await service.dismissAllSampleCards('user-uuid-1');

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.update).toHaveBeenCalledWith(
        User,
        'user-uuid-1',
        expect.objectContaining({ sampleCardsDismissedAt: expect.any(Date) }),
      );
      expect(manager.createQueryBuilder).toHaveBeenCalled();
    });

    it('이미 dismiss 됨 → no-op (transaction 호출 X)', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ sampleCardsDismissedAt: new Date('2026-06-25') }),
      );

      await service.dismissAllSampleCards('user-uuid-1');

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('존재하지 않는 user → 404', async () => {
      userRepo.findOneBy.mockResolvedValue(null);

      await expect(
        service.dismissAllSampleCards('nonexistent'),
      ).rejects.toThrow(NotFoundException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('트랜잭션 wrap — User update + applications mass update 둘 다 같은 TX', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ sampleCardsDismissedAt: null }),
      );

      await service.dismissAllSampleCards('user-uuid-1');

      // transaction callback 안에서 manager.update + createQueryBuilder 둘 다 호출
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.update).toHaveBeenCalledTimes(1);
      expect(manager.createQueryBuilder).toHaveBeenCalledTimes(1);
    });
  });

  // ── 캘린더 UX 재구성: dismissCalendarHomeIntro ─────────────
  describe('dismissCalendarHomeIntro', () => {
    it('정상 → users.calendar_home_intro_dismissed_at 에 현재 시각 저장', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ calendarHomeIntroDismissedAt: null }),
      );

      await service.dismissCalendarHomeIntro('user-uuid-1');

      expect(userRepo.update).toHaveBeenCalledWith(
        'user-uuid-1',
        expect.objectContaining({
          calendarHomeIntroDismissedAt: expect.any(Date),
        }),
      );
    });

    it('이미 dismiss 됨 → no-op (update 호출 X, 멱등)', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({
          calendarHomeIntroDismissedAt: new Date('2026-07-02'),
        }),
      );

      await service.dismissCalendarHomeIntro('user-uuid-1');

      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('존재하지 않는 user → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);

      await expect(
        service.dismissCalendarHomeIntro('nonexistent'),
      ).rejects.toThrow(NotFoundException);
      expect(userRepo.update).not.toHaveBeenCalled();
    });
  });
});
