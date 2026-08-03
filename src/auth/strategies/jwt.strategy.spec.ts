import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnauthorizedException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { JwtStrategy, LAST_ACTIVE_THROTTLE_MS } from './jwt.strategy';
import { User } from '../../users/user.entity';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-uuid',
    kakaoId: 'kakao-123',
    appleSub: null,
    appleEmail: null,
    appleRefreshToken: null,
    firstAppLoginAt: null,
    firstWebLoginAt: null,
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

    it('직전 요청(1분 미만) → 갱신·insert 모두 안 탐', async () => {
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

  /**
   * ① lastActiveAt 정확도 — 하루 1회 → 1분 throttle.
   *
   * 전에는 저장값이 **그날 첫 접속 시각**이라 admin 이 보는 "마지막 접속" 이 최대 하루 과거였다
   * (2026-07-30 실측: 화면 17:15 / 실제 사용 22:38).
   *
   * 경우의 수:
   *  1. 임계 초과 → 갱신 O, 값이 현재 시각
   *  2. 경계 정확히 60초 → 갱신 O (>= 이므로)
   *  3. 경계 59초 → 갱신 X
   *  4. lastActiveAt null (신규 유저) → 갱신 O
   *  5. 갱신 실패해도 인증 성공 (best-effort)
   *  6. 🔴 같은 KST 날짜인데 임계 초과 → 갱신 O · 방문 insert **X** (분리 검증)
   */
  describe('마지막 접속 시각 throttle', () => {
    const managerQuery = () =>
      (userRepo.manager as unknown as { query: jest.Mock }).query;

    // KST 정오로 고정 — 실행 시각이 자정 근처면 "같은 날" 판정이 흔들려 flaky 해진다
    const NOW = new Date('2026-07-30T03:00:00.000Z'); // = 12:00 KST

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(NOW);
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('1. 임계 초과 → lastActiveAt 을 현재 시각으로 갱신', async () => {
      userRepo.findOne.mockResolvedValue(
        makeUser({ lastActiveAt: new Date(NOW.getTime() - 5 * 60_000) }),
      );

      await strategy.validate({ sub: 'user-uuid', role: 'user' });

      expect(userRepo.update).toHaveBeenCalledTimes(1);
      const [, patch] = userRepo.update.mock.calls[0] as [
        string,
        { lastActiveAt: Date },
      ];
      expect(patch.lastActiveAt.getTime()).toBe(NOW.getTime());
    });

    it('2. 경계 — 정확히 임계값이면 갱신한다 (>=)', async () => {
      userRepo.findOne.mockResolvedValue(
        makeUser({
          lastActiveAt: new Date(NOW.getTime() - LAST_ACTIVE_THROTTLE_MS),
        }),
      );

      await strategy.validate({ sub: 'user-uuid', role: 'user' });

      expect(userRepo.update).toHaveBeenCalledTimes(1);
    });

    it('3. 경계 — 임계값 1ms 전이면 갱신하지 않는다', async () => {
      userRepo.findOne.mockResolvedValue(
        makeUser({
          lastActiveAt: new Date(NOW.getTime() - LAST_ACTIVE_THROTTLE_MS + 1),
        }),
      );

      await strategy.validate({ sub: 'user-uuid', role: 'user' });

      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('4. lastActiveAt 이 null (첫 접속) → 갱신 + 방문 insert', async () => {
      userRepo.findOne.mockResolvedValue(makeUser({ lastActiveAt: null }));

      await strategy.validate({ sub: 'user-uuid', role: 'user' });

      expect(userRepo.update).toHaveBeenCalledTimes(1);
      expect(managerQuery()).toHaveBeenCalledTimes(1);
    });

    it('5. 갱신 실패해도 인증(validate)은 성공한다 — best-effort', async () => {
      userRepo.findOne.mockResolvedValue(
        makeUser({ lastActiveAt: new Date(NOW.getTime() - 5 * 60_000) }),
      );
      userRepo.update.mockRejectedValue(new Error('DB down'));

      const result = await strategy.validate({
        sub: 'user-uuid',
        role: 'user',
      });

      expect(result).toMatchObject({ id: 'user-uuid' });
    });

    it('6. 🔴 같은 KST 날짜 + 임계 초과 → 갱신은 하지만 방문 insert 는 안 한다', async () => {
      // 이게 분리의 이유다. 묶여 있으면 no-op INSERT 가 분당 한 번씩 날아간다.
      userRepo.findOne.mockResolvedValue(
        makeUser({ lastActiveAt: new Date(NOW.getTime() - 2 * 60_000) }), // 11:58 KST, 같은 날
      );

      await strategy.validate({ sub: 'user-uuid', role: 'user' });

      expect(userRepo.update).toHaveBeenCalledTimes(1);
      expect(managerQuery()).not.toHaveBeenCalled();
    });

    it('7. KST 날짜가 바뀌면 → 갱신 + 방문 insert 둘 다, 날짜는 KST 기준', async () => {
      userRepo.findOne.mockResolvedValue(
        makeUser({ lastActiveAt: new Date('2026-07-29T03:00:00.000Z') }),
      );

      await strategy.validate({ sub: 'user-uuid', role: 'user' });

      expect(userRepo.update).toHaveBeenCalledTimes(1);
      const [, params] = managerQuery().mock.calls[0] as [
        string,
        [string, string],
      ];
      expect(params[1]).toBe('2026-07-30'); // UTC 로는 07-30 03:00 → KST 도 07-30
    });

    it('8. UTC 와 KST 날짜가 갈리는 시각에도 KST 날짜로 기록한다', async () => {
      // UTC 2026-07-30 16:00 = KST 2026-07-31 01:00 → 방문일은 07-31 이어야 한다
      jest.setSystemTime(new Date('2026-07-30T16:00:00.000Z'));
      userRepo.findOne.mockResolvedValue(
        makeUser({ lastActiveAt: new Date('2026-07-30T03:00:00.000Z') }),
      );

      await strategy.validate({ sub: 'user-uuid', role: 'user' });

      const [, params] = managerQuery().mock.calls[0] as [
        string,
        [string, string],
      ];
      expect(params[1]).toBe('2026-07-31');
    });
  });
});
