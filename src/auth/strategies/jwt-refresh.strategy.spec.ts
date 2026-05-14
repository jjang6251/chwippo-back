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
    nickname: '테스트유저',
    email: 'test@test.com',
    refreshToken: REFRESH_TOKEN,
    role: 'user',
    createdAt: new Date('2026-01-01'),
    lastActiveAt: new Date('2026-05-01'),
    termsAgreedAt: new Date('2026-01-01'),
    dashboardConfig: null,
    onboardedAt: null,
    suspendedAt: null,
    ...overrides,
  } as User;
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

  it('정상: refresh token 일치 + 활성 유저 → 유저 정보 반환', async () => {
    userRepo.findOne.mockResolvedValue(makeUser());
    const req = makeRequest(REFRESH_TOKEN);

    const result = await strategy.validate(req, { sub: 'user-uuid' });

    expect(result).toMatchObject({ id: 'user-uuid', role: 'user' });
  });

  it('refresh token 쿠키 없음 → UnauthorizedException', async () => {
    const req = makeRequest(undefined);

    await expect(
      strategy.validate(req, { sub: 'user-uuid' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('유저가 존재하지 않으면 UnauthorizedException', async () => {
    userRepo.findOne.mockResolvedValue(null);
    const req = makeRequest(REFRESH_TOKEN);

    await expect(
      strategy.validate(req, { sub: 'not-exist' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('저장된 refresh token과 불일치 → UnauthorizedException', async () => {
    userRepo.findOne.mockResolvedValue(makeUser({ refreshToken: 'different-token' }));
    const req = makeRequest(REFRESH_TOKEN);

    await expect(
      strategy.validate(req, { sub: 'user-uuid' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('정지된 유저 (suspendedAt !== null) → UnauthorizedException (refresh 경로 우회 차단)', async () => {
    userRepo.findOne.mockResolvedValue(makeUser({ suspendedAt: new Date() }));
    const req = makeRequest(REFRESH_TOKEN);

    await expect(
      strategy.validate(req, { sub: 'user-uuid' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('정지된 어드민도 refresh 경로 차단', async () => {
    userRepo.findOne.mockResolvedValue(
      makeUser({ role: 'admin', suspendedAt: new Date() }),
    );
    const req = makeRequest(REFRESH_TOKEN);

    await expect(
      strategy.validate(req, { sub: 'user-uuid' }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
