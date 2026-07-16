import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnauthorizedException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { JwtRefreshStrategy } from './jwt-refresh.strategy';
import { User } from '../../users/user.entity';
import type { Request } from 'express';

const REFRESH_TOKEN = 'valid-refresh-token';

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

function makeRequest(refreshToken: string | undefined): Request {
  return {
    cookies: refreshToken ? { refresh_token: refreshToken } : {},
  } as unknown as Request;
}

const mockUserRepo = () => ({
  findOne: jest.fn(),
});

const mockConfigService = {
  getOrThrow: jest.fn().mockReturnValue('test-refresh-secret'),
};

describe('JwtRefreshStrategy', () => {
  let strategy: JwtRefreshStrategy;
  let userRepo: jest.Mocked<Repository<User>>;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtRefreshStrategy,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: getRepositoryToken(User), useFactory: mockUserRepo },
      ],
    }).compile();

    strategy = module.get(JwtRefreshStrategy);
    userRepo = module.get(getRepositoryToken(User));
  });

  // 세션 지속성 웨이브(B안): token_hash 대조 + rotation(토큰 패밀리 재사용 감지)은
  // AuthService.rotateTokens 에서 원자적으로 수행. strategy 는 서명·존재·정지만 검증하고
  // sid + rawToken 을 controller 로 전달한다 (hash 불일치·재사용 판정은 service spec 참조).

  it('정상: 서명 유효 + 유저 존재 → 프로필 + sid + rawToken 반환', async () => {
    userRepo.findOne.mockResolvedValue(makeUser());
    const req = makeRequest(REFRESH_TOKEN);

    const result = await strategy.validate(req, {
      sub: 'user-uuid',
      sid: 'sid-1',
    });

    expect(result).toMatchObject({
      id: 'user-uuid',
      role: 'user',
      sid: 'sid-1',
      refreshTokenRaw: REFRESH_TOKEN,
    });
  });

  it('sid 없는 구 토큰 (payload 에 sid 없음) → sid null 로 전달 (service 가 401 처리)', async () => {
    userRepo.findOne.mockResolvedValue(makeUser());
    const req = makeRequest(REFRESH_TOKEN);

    const result = await strategy.validate(req, { sub: 'user-uuid' });

    expect(result).toMatchObject({ sid: null, refreshTokenRaw: REFRESH_TOKEN });
  });

  it('refresh token 쿠키 없음 → UnauthorizedException', async () => {
    const req = makeRequest(undefined);

    await expect(strategy.validate(req, { sub: 'user-uuid' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('유저가 존재하지 않으면 UnauthorizedException', async () => {
    userRepo.findOne.mockResolvedValue(null);
    const req = makeRequest(REFRESH_TOKEN);

    await expect(strategy.validate(req, { sub: 'not-exist' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('정지된 유저 (suspendedAt !== null) → UnauthorizedException (refresh 경로 우회 차단)', async () => {
    userRepo.findOne.mockResolvedValue(makeUser({ suspendedAt: new Date() }));
    const req = makeRequest(REFRESH_TOKEN);

    await expect(strategy.validate(req, { sub: 'user-uuid' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('정지된 어드민도 refresh 경로 차단', async () => {
    userRepo.findOne.mockResolvedValue(
      makeUser({ role: 'admin', suspendedAt: new Date() }),
    );
    const req = makeRequest(REFRESH_TOKEN);

    await expect(strategy.validate(req, { sub: 'user-uuid' })).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
