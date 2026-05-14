import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { User } from '../users/user.entity';

const FRONTEND_URL = 'http://localhost:5173';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-uuid',
    kakaoId: 'kakao-123',
    nickname: '테스트유저',
    email: 'test@test.com',
    refreshToken: null,
    role: 'user',
    createdAt: new Date('2026-01-01'),
    lastActiveAt: null,
    termsAgreedAt: new Date('2026-01-01'),
    dashboardConfig: null,
    onboardedAt: null,
    suspendedAt: null,
    ...overrides,
  } as User;
}

function makeRes(): jest.Mocked<Pick<Response, 'redirect' | 'cookie'>> {
  return {
    redirect: jest.fn(),
    cookie: jest.fn(),
  } as jest.Mocked<Pick<Response, 'redirect' | 'cookie'>>;
}

const mockAuthService = {
  findOrCreateKakaoUser: jest.fn(),
  issueTokens: jest.fn(),
};

const mockConfigService = {
  get: jest.fn().mockImplementation((key: string, defaultVal?: string) => {
    if (key === 'FRONTEND_URL') return FRONTEND_URL;
    return defaultVal ?? '';
  }),
};

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    controller = module.get(AuthController);
  });

  describe('kakaoCallback()', () => {
    it('정상 활성 유저 → access_token 포함 프론트 URL로 리다이렉트', async () => {
      const user = makeUser();
      mockAuthService.findOrCreateKakaoUser.mockResolvedValue({ user, isNew: false });
      mockAuthService.issueTokens.mockResolvedValue({
        accessToken: 'access-token-value',
        refreshToken: 'refresh-token-value',
      });

      const req = { user: { kakaoId: 'kakao-123', nickname: '테스트유저', email: null } } as any;
      const res = makeRes() as unknown as Response;

      await controller.kakaoCallback(req, res);

      expect(res.cookie).toHaveBeenCalledWith('refresh_token', 'refresh-token-value', expect.any(Object));
      const redirectUrl: string = (res.redirect as jest.Mock).mock.calls[0][0];
      expect(redirectUrl).toContain(`${FRONTEND_URL}/login/callback`);
      expect(redirectUrl).toContain('access_token=access-token-value');
    });

    it('정지된 유저 → /login?error=suspended 리다이렉트 (토큰 발급 안 함)', async () => {
      const suspendedUser = makeUser({ suspendedAt: new Date() });
      mockAuthService.findOrCreateKakaoUser.mockResolvedValue({ user: suspendedUser, isNew: false });

      const req = { user: { kakaoId: 'kakao-123', nickname: '테스트유저', email: null } } as any;
      const res = makeRes() as unknown as Response;

      await controller.kakaoCallback(req, res);

      expect(mockAuthService.issueTokens).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
      const redirectUrl: string = (res.redirect as jest.Mock).mock.calls[0][0];
      expect(redirectUrl).toBe(`${FRONTEND_URL}/login?error=suspended`);
    });

    it('정지된 어드민도 /login?error=suspended 리다이렉트', async () => {
      const suspendedAdmin = makeUser({ role: 'admin', suspendedAt: new Date() });
      mockAuthService.findOrCreateKakaoUser.mockResolvedValue({ user: suspendedAdmin, isNew: false });

      const req = { user: { kakaoId: 'kakao-admin', nickname: '어드민', email: null } } as any;
      const res = makeRes() as unknown as Response;

      await controller.kakaoCallback(req, res);

      expect(mockAuthService.issueTokens).not.toHaveBeenCalled();
      const redirectUrl: string = (res.redirect as jest.Mock).mock.calls[0][0];
      expect(redirectUrl).toBe(`${FRONTEND_URL}/login?error=suspended`);
    });

    it('신규 유저(termsAgreedAt=null)는 needs_terms=true로 리다이렉트', async () => {
      const newUser = makeUser({ termsAgreedAt: null });
      mockAuthService.findOrCreateKakaoUser.mockResolvedValue({ user: newUser, isNew: true });
      mockAuthService.issueTokens.mockResolvedValue({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });

      const req = { user: { kakaoId: 'kakao-new', nickname: '신규', email: null } } as any;
      const res = makeRes() as unknown as Response;

      await controller.kakaoCallback(req, res);

      const redirectUrl: string = (res.redirect as jest.Mock).mock.calls[0][0];
      expect(redirectUrl).toContain('needs_terms=true');
    });

    it('기존 유저(termsAgreedAt 있음)는 needs_terms=false로 리다이렉트', async () => {
      const existingUser = makeUser({ termsAgreedAt: new Date('2026-01-01') });
      mockAuthService.findOrCreateKakaoUser.mockResolvedValue({ user: existingUser, isNew: false });
      mockAuthService.issueTokens.mockResolvedValue({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });

      const req = { user: { kakaoId: 'kakao-exist', nickname: '기존', email: null } } as any;
      const res = makeRes() as unknown as Response;

      await controller.kakaoCallback(req, res);

      const redirectUrl: string = (res.redirect as jest.Mock).mock.calls[0][0];
      expect(redirectUrl).toContain('needs_terms=false');
    });
  });
});
