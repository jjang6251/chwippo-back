import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnauthorizedException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { JwtStrategy } from './jwt.strategy';
import { User } from '../../users/user.entity';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-uuid',
    kakaoId: 'kakao-123',
    appleSub: null,
    appleEmail: null,
    appleRefreshToken: null,
    nickname: '테스트유저',
    email: 'test@test.com',
    role: 'user',
    createdAt: new Date('2026-01-01'),
    lastActiveAt: new Date('2026-05-01'),
    termsAgreedAt: new Date('2026-01-01'),
    dashboardConfig: null,
    alarmConfig: null,
    alarmPromptedAt: null,
    alarmPermissionGranted: false,
    onboardedAt: null,
    suspendedAt: null,
    aiConsentAt: null,
    aiConsentVersion: null,
    onboardedCoinAt: null,
    suspendReason: null,
    suspendExpiresAt: null,
    pendingNotification: null,
    signupJobCategories: null,
    signupOtherText: null,
    sampleCardsDismissedAt: null,
    calendarHomeIntroDismissedAt: null,
    sessionExpiredNotifiedAt: null,
    tier: 'free',
    ...overrides,
  };
}

const mockUserRepo = () => ({
  findOne: jest.fn(),
  update: jest.fn().mockResolvedValue(undefined),
  // A8 — user_daily_visits insert 경로 (manager.query)
  manager: { query: jest.fn().mockResolvedValue(undefined) },
});

const mockConfigService = {
  getOrThrow: jest.fn().mockReturnValue('test-secret'),
};

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let userRepo: jest.Mocked<Repository<User>>;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: getRepositoryToken(User), useFactory: mockUserRepo },
      ],
    }).compile();

    strategy = module.get(JwtStrategy);
    userRepo = module.get(getRepositoryToken(User));
  });

  it('정상: 활성 유저 → id·nickname·email·role 반환', async () => {
    userRepo.findOne.mockResolvedValue(makeUser());

    const result = await strategy.validate({ sub: 'user-uuid', role: 'user' });

    expect(result).toMatchObject({
      id: 'user-uuid',
      nickname: '테스트유저',
      role: 'user',
    });
  });

  it('유저가 존재하지 않으면 UnauthorizedException', async () => {
    userRepo.findOne.mockResolvedValue(null);

    await expect(
      strategy.validate({ sub: 'not-exist', role: 'user' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('정지된 유저 (suspendedAt !== null) → UnauthorizedException', async () => {
    userRepo.findOne.mockResolvedValue(makeUser({ suspendedAt: new Date() }));

    await expect(
      strategy.validate({ sub: 'user-uuid', role: 'user' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('정지된 유저는 role이 admin이어도 차단된다', async () => {
    userRepo.findOne.mockResolvedValue(
      makeUser({ role: 'admin', suspendedAt: new Date() }),
    );

    await expect(
      strategy.validate({ sub: 'user-uuid', role: 'admin' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  // A8 — 일별 방문 기록 (user_daily_visits)
  describe('방문 기록 (A8)', () => {
    const managerQuery = () =>
      (userRepo.manager as unknown as { query: jest.Mock }).query;

    it('KST 오늘 첫 요청 (lastActiveAt 과거) → lastActiveAt 갱신 + 방문 insert', async () => {
      userRepo.findOne.mockResolvedValue(
        makeUser({ lastActiveAt: new Date('2026-05-01') }),
      );

      await strategy.validate({ sub: 'user-uuid', role: 'user' });

      expect(userRepo.update).toHaveBeenCalledTimes(1);
      expect(managerQuery()).toHaveBeenCalledTimes(1);
      const [sql, params] = managerQuery().mock.calls[0] as [
        string,
        [string, string],
      ];
      expect(sql).toContain('INSERT INTO user_daily_visits');
      expect(sql).toContain('ON CONFLICT DO NOTHING');
      expect(params[0]).toBe('user-uuid');
      expect(params[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/); // KST YYYY-MM-DD
    });

    it('lastActiveAt 이 KST 오늘이면 → 갱신·insert 모두 안 탐', async () => {
      userRepo.findOne.mockResolvedValue(
        makeUser({ lastActiveAt: new Date() }),
      );

      await strategy.validate({ sub: 'user-uuid', role: 'user' });

      expect(userRepo.update).not.toHaveBeenCalled();
      expect(managerQuery()).not.toHaveBeenCalled();
    });

    it('방문 insert 실패해도 인증(validate)은 정상 성공 — best-effort', async () => {
      userRepo.findOne.mockResolvedValue(
        makeUser({ lastActiveAt: new Date('2026-05-01') }),
      );
      managerQuery().mockRejectedValue(new Error('DB down'));

      const result = await strategy.validate({
        sub: 'user-uuid',
        role: 'user',
      });

      expect(result).toMatchObject({ id: 'user-uuid' });
    });
  });
});
