import { Test, TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
// jose 는 ESM 전용 · Jest 는 CommonJS · UsersService import 체인(identity-provider→apple-token→jose) 때문에 mock 필수
jest.mock('jose', () => ({
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  SignJWT: jest.fn(),
  importPKCS8: jest.fn(),
}));
import { UsersService } from '../users/users.service';
import { ApplicationsService } from '../applications/applications.service';
import { DiscordNotifier } from '../common/discord-notifier';
import { toKstDateString } from '../common/datetime';
import { ReviewerSeedService } from './reviewer-seed.service';

/**
 * ReviewerSeedService 단위 — App Review 리뷰어 계정 자동 시딩.
 *
 * 검증 축:
 *  - 정상: 약관·온보딩·샘플(signupAnswer ['백엔드 개발']) + 카카오(it_dev)·네이버(general) 카드
 *    + 카카오 1차 기술면접(idx2) 상세(날짜/장소/메모) + currentStep=2 + 네이버 서류(idx0) 마감
 *  - 날짜: src/common/datetime KST 헬퍼 기준 (오늘+3 14:00 / 오늘+5 18:00 · +09:00)
 *  - 기존 서비스 공개 메서드만 재사용 (raw repo write 없음)
 *  - best-effort: 서브 서비스 throw 해도 seedReviewerData 는 throw 안 함 + Discord ops 통지
 */
describe('ReviewerSeedService', () => {
  let service: ReviewerSeedService;
  let mockUsers: {
    agreeTerms: jest.Mock;
    markOnboarded: jest.Mock;
    signupAnswer: jest.Mock;
  };
  let mockApps: {
    create: jest.Mock;
    update: jest.Mock;
    updateStep: jest.Mock;
    updateCurrentStep: jest.Mock;
  };
  let mockDiscord: { notify: jest.Mock };

  const USER_ID = 'u-rev';

  const kakaoSteps = [
    { id: 'k0', orderIndex: 0 },
    { id: 'k1', orderIndex: 1 },
    { id: 'k2', orderIndex: 2 }, // 1차 기술면접
    { id: 'k3', orderIndex: 3 },
    { id: 'k4', orderIndex: 4 },
  ];
  const naverSteps = [
    { id: 'n0', orderIndex: 0 }, // 서류 제출
    { id: 'n1', orderIndex: 1 },
    { id: 'n2', orderIndex: 2 },
    { id: 'n3', orderIndex: 3 },
  ];

  beforeEach(async () => {
    mockUsers = {
      agreeTerms: jest.fn().mockResolvedValue(undefined),
      markOnboarded: jest.fn().mockResolvedValue(undefined),
      signupAnswer: jest.fn().mockResolvedValue(undefined),
    };
    mockApps = {
      create: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      updateStep: jest.fn().mockResolvedValue(undefined),
      updateCurrentStep: jest.fn().mockResolvedValue(undefined),
    };
    mockDiscord = { notify: jest.fn().mockResolvedValue('sent') };

    const moduleRefMock = {
      get: (token: unknown) => {
        if (token === UsersService) return mockUsers;
        if (token === ApplicationsService) return mockApps;
        return undefined;
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewerSeedService,
        { provide: ModuleRef, useValue: moduleRefMock },
        { provide: DiscordNotifier, useValue: mockDiscord },
      ],
    }).compile();

    service = module.get(ReviewerSeedService);
  });

  function primeCards(): void {
    mockApps.create
      .mockResolvedValueOnce({ id: 'app-kakao', steps: kakaoSteps })
      .mockResolvedValueOnce({ id: 'app-naver', steps: naverSteps });
  }

  it('정상 시딩 → 약관·온보딩·샘플 + 카카오/네이버 카드 + 면접/서류 상세', async () => {
    primeCards();

    await service.seedReviewerData(USER_ID);

    // 1. 약관·온보딩·샘플
    expect(mockUsers.agreeTerms).toHaveBeenCalledWith(USER_ID);
    expect(mockUsers.markOnboarded).toHaveBeenCalledWith(USER_ID);
    expect(mockUsers.signupAnswer).toHaveBeenCalledWith(USER_ID, {
      jobCategories: ['백엔드 개발'],
    });

    // 2. 카카오 (it_dev · 서버 개발자)
    expect(mockApps.create).toHaveBeenNthCalledWith(
      1,
      USER_ID,
      expect.objectContaining({
        companyName: '카카오',
        templateId: 'it_dev',
        jobTitle: '서버 개발자',
        status: 'IN_PROGRESS',
      }),
    );
    // 1차 기술면접(idx2) 상세 — 날짜·장소 (메모는 카드 레벨)
    expect(mockApps.updateStep).toHaveBeenCalledWith(
      USER_ID,
      'app-kakao',
      'k2',
      expect.objectContaining({
        location: '판교 카카오 아지트',
        scheduledDate: expect.any(String),
      }),
    );
    // 메모는 카드(application) 레벨 — 수동 pre-load 와 동일
    expect(mockApps.update).toHaveBeenCalledWith(
      USER_ID,
      'app-kakao',
      expect.objectContaining({
        memo: expect.stringContaining('기술 블로그'),
      }),
    );
    // 현재 스텝 = 2
    expect(mockApps.updateCurrentStep).toHaveBeenCalledWith(
      USER_ID,
      'app-kakao',
      2,
    );

    // 3. 네이버 (general · 백엔드 개발자) — 서류(idx0) 마감
    expect(mockApps.create).toHaveBeenNthCalledWith(
      2,
      USER_ID,
      expect.objectContaining({
        companyName: '네이버',
        templateId: 'general',
        jobTitle: '백엔드 개발자',
      }),
    );
    expect(mockApps.updateStep).toHaveBeenCalledWith(
      USER_ID,
      'app-naver',
      'n0',
      expect.objectContaining({ scheduledDate: expect.any(String) }),
    );
  });

  it('스텝 scheduledDate 는 KST 기준 (오늘+3 14:00 / 오늘+5 18:00 · +09:00)', async () => {
    primeCards();

    await service.seedReviewerData(USER_ID);

    const kakaoCall = mockApps.updateStep.mock.calls.find((c) => c[2] === 'k2');
    const naverCall = mockApps.updateStep.mock.calls.find((c) => c[2] === 'n0');
    const kakaoDto = kakaoCall?.[3] as { scheduledDate?: string } | undefined;
    const naverDto = naverCall?.[3] as { scheduledDate?: string } | undefined;

    const d3 = toKstDateString(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
    const d5 = toKstDateString(new Date(Date.now() + 5 * 24 * 60 * 60 * 1000));

    expect(kakaoDto?.scheduledDate).toBe(`${d3}T14:00:00+09:00`);
    expect(naverDto?.scheduledDate).toBe(`${d5}T18:00:00+09:00`);
  });

  it('best-effort — 카드 생성 throw → seedReviewerData throw 안 함 + Discord ops 통지', async () => {
    mockApps.create.mockRejectedValue(new Error('db down'));

    await expect(service.seedReviewerData(USER_ID)).resolves.toBeUndefined();

    expect(mockDiscord.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('시딩 실패') }),
      'ops',
    );
  });

  it('best-effort — signupAnswer throw → throw 안 함 · 카드 생성 시도 안 함', async () => {
    mockUsers.signupAnswer.mockRejectedValue(new Error('already answered'));

    await expect(service.seedReviewerData(USER_ID)).resolves.toBeUndefined();

    expect(mockApps.create).not.toHaveBeenCalled();
  });
});
