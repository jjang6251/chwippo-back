import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import { JwtRefreshStrategy } from './jwt-refresh.strategy';
import { User } from '../../users/user.entity';
import type { Request } from 'express';

const REFRESH_TOKEN = 'valid-refresh-token';
const REFRESH_TOKEN_HASH = createHash('sha256')
  .update(REFRESH_TOKEN)
  .digest('hex');

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-uuid',
    kakaoId: 'kakao-123',
    nickname: '테스트유저',
    email: 'test@test.com',
    // DB엔 hash 저장 (LRR P1T1 M-2)
    refreshToken: REFRESH_TOKEN_HASH,
    role: 'user',
    createdAt: new Date('2026-01-01'),
    lastActiveAt: new Date('2026-05-01'),
    termsAgreedAt: new Date('2026-01-01'),
    dashboardConfig: null,
    onboardedAt: null,
    suspendedAt: null,
    aiConsentAt: null,
    aiConsentVersion: null,
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

  it('정상: cookie 평문 JWT를 hash해서 DB hash와 일치 → 유저 정보 반환', async () => {
    userRepo.findOne.mockResolvedValue(makeUser());
    const req = makeRequest(REFRESH_TOKEN);

    const result = await strategy.validate(req, { sub: 'user-uuid' });

    expect(result).toMatchObject({ id: 'user-uuid', role: 'user' });
  });

  it('DB에 평문 token 저장된 상태 (PR C 도입 직후 기존 사용자) → hash 비교 실패 → 401', async () => {
    // 마이그레이션 옵션 a: 코드 변경만, 기존 평문 DB 값은 자연스러운 강제 재로그인
    userRepo.findOne.mockResolvedValue(
      makeUser({ refreshToken: REFRESH_TOKEN }), // ← 평문 그대로 (도입 전 상태)
    );
    const req = makeRequest(REFRESH_TOKEN);

    await expect(strategy.validate(req, { sub: 'user-uuid' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('DB refresh_token이 NULL (로그아웃 후) → 401', async () => {
    userRepo.findOne.mockResolvedValue(makeUser({ refreshToken: null }));
    const req = makeRequest(REFRESH_TOKEN);

    await expect(strategy.validate(req, { sub: 'user-uuid' })).rejects.toThrow(
      UnauthorizedException,
    );
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

  it('저장된 hash와 불일치 (다른 token으로 시도) → UnauthorizedException', async () => {
    const otherHash = createHash('sha256').update('other-token').digest('hex');
    userRepo.findOne.mockResolvedValue(makeUser({ refreshToken: otherHash }));
    const req = makeRequest(REFRESH_TOKEN);

    await expect(strategy.validate(req, { sub: 'user-uuid' })).rejects.toThrow(
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
