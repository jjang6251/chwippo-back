import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { User } from '../users/user.entity';

const FRONTEND_URL = 'http://localhost:5173';
const KAKAO_CLIENT_ID = 'kakao-app-id';
const KAKAO_REDIRECT_URI = 'http://localhost:3000/auth/kakao/callback';
const VALID_STATE = 'a'.repeat(64); // 32바이트 hex

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
    aiConsentAt: null,
    aiConsentVersion: null,
    onboardedCoinAt: null,
    suspendReason: null,
    suspendExpiresAt: null,
    pendingNotification: null,
    tier: 'free',
    ...overrides,
  };
}

function makeRes(): jest.Mocked<
  Pick<Response, 'redirect' | 'cookie' | 'clearCookie'>
> {
  return {
    redirect: jest.fn(),
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  } as jest.Mocked<Pick<Response, 'redirect' | 'cookie' | 'clearCookie'>>;
}

/** state·cookie 일치하는 valid callback request 생성 헬퍼 */
function makeValidCallbackReq(kakaoUser: {
  kakaoId: string;
  nickname: string;
  email: string | null;
}) {
  return {
    user: kakaoUser,
    cookies: { oauth_state: VALID_STATE },
    query: { state: VALID_STATE },
  } as unknown as Parameters<typeof AuthController.prototype.kakaoCallback>[0];
}

const mockAuthService = {
  findOrCreateKakaoUser: jest.fn(),
  issueTokens: jest.fn(),
  refreshTokens: jest.fn(),
};

const mockConfigService = {
  get: jest.fn().mockImplementation((key: string, defaultVal?: string) => {
    if (key === 'FRONTEND_URL') return FRONTEND_URL;
    return defaultVal ?? '';
  }),
  getOrThrow: jest.fn().mockImplementation((key: string) => {
    if (key === 'KAKAO_CLIENT_ID') return KAKAO_CLIENT_ID;
    if (key === 'KAKAO_REDIRECT_URI') return KAKAO_REDIRECT_URI;
    throw new Error(`Unknown key: ${key}`);
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

  describe('kakaoLogin() — OAuth state nonce 생성', () => {
    it('oauth_state cookie set + 카카오 OAuth URL로 redirect (state 포함)', () => {
      const res = makeRes() as unknown as Response;
      controller.kakaoLogin(res);

      // cookie set 검증
      const cookieCall = (res.cookie as jest.Mock).mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];
      expect(cookieCall[0]).toBe('oauth_state');
      expect(typeof cookieCall[1]).toBe('string');
      expect(cookieCall[1].length).toBe(64); // 32 bytes hex
      expect(cookieCall[2]).toEqual(
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
        }),
      );

      // redirect URL 검증
      const redirectUrl = (res.redirect as jest.Mock).mock
        .calls[0][0] as string;
      expect(redirectUrl).toContain('https://kauth.kakao.com/oauth/authorize');
      expect(redirectUrl).toContain(`client_id=${KAKAO_CLIENT_ID}`);
      expect(redirectUrl).toContain(
        `redirect_uri=${encodeURIComponent(KAKAO_REDIRECT_URI)}`,
      );
      expect(redirectUrl).toContain('response_type=code');
      expect(redirectUrl).toContain(`state=${cookieCall[1]}`);
    });

    it('호출마다 nonce 새로 생성 (재사용 X)', () => {
      const res1 = makeRes() as unknown as Response;
      const res2 = makeRes() as unknown as Response;
      controller.kakaoLogin(res1);
      controller.kakaoLogin(res2);
      const nonce1 = (res1.cookie as jest.Mock).mock.calls[0][1] as string;
      const nonce2 = (res2.cookie as jest.Mock).mock.calls[0][1] as string;
      expect(nonce1).not.toBe(nonce2);
    });
  });

  describe('kakaoCallback() — state 검증', () => {
    it('cookie 없음 → /login?error=oauth_state_mismatch 리다이렉트', async () => {
      const req = {
        user: { kakaoId: 'k', nickname: 'n', email: null },
        cookies: {},
        query: { state: VALID_STATE },
      } as any;
      const res = makeRes() as unknown as Response;
      await controller.kakaoCallback(req, res);
      expect(res.clearCookie).toHaveBeenCalledWith('oauth_state', {
        path: '/',
      });
      expect(mockAuthService.findOrCreateKakaoUser).not.toHaveBeenCalled();
      expect((res.redirect as jest.Mock).mock.calls[0][0]).toBe(
        `${FRONTEND_URL}/login?error=oauth_state_mismatch`,
      );
    });

    it('query.state 없음 → mismatch 리다이렉트', async () => {
      const req = {
        user: { kakaoId: 'k', nickname: 'n', email: null },
        cookies: { oauth_state: VALID_STATE },
        query: {},
      } as any;
      const res = makeRes() as unknown as Response;
      await controller.kakaoCallback(req, res);
      expect(mockAuthService.findOrCreateKakaoUser).not.toHaveBeenCalled();
      expect((res.redirect as jest.Mock).mock.calls[0][0]).toBe(
        `${FRONTEND_URL}/login?error=oauth_state_mismatch`,
      );
    });

    it('state 불일치 → mismatch 리다이렉트', async () => {
      const req = {
        user: { kakaoId: 'k', nickname: 'n', email: null },
        cookies: { oauth_state: 'a'.repeat(64) },
        query: { state: 'b'.repeat(64) },
      } as any;
      const res = makeRes() as unknown as Response;
      await controller.kakaoCallback(req, res);
      expect(mockAuthService.findOrCreateKakaoUser).not.toHaveBeenCalled();
      expect((res.redirect as jest.Mock).mock.calls[0][0]).toBe(
        `${FRONTEND_URL}/login?error=oauth_state_mismatch`,
      );
    });

    it('query.state가 배열(다중 파라미터) → mismatch 리다이렉트 (type 안전)', async () => {
      const req = {
        user: { kakaoId: 'k', nickname: 'n', email: null },
        cookies: { oauth_state: VALID_STATE },
        query: { state: [VALID_STATE, 'other'] },
      } as any;
      const res = makeRes() as unknown as Response;
      await controller.kakaoCallback(req, res);
      expect(mockAuthService.findOrCreateKakaoUser).not.toHaveBeenCalled();
      expect((res.redirect as jest.Mock).mock.calls[0][0]).toBe(
        `${FRONTEND_URL}/login?error=oauth_state_mismatch`,
      );
    });

    it('cookie 빈 문자열 → mismatch 리다이렉트', async () => {
      const req = {
        user: { kakaoId: 'k', nickname: 'n', email: null },
        cookies: { oauth_state: '' },
        query: { state: '' },
      } as any;
      const res = makeRes() as unknown as Response;
      await controller.kakaoCallback(req, res);
      expect(mockAuthService.findOrCreateKakaoUser).not.toHaveBeenCalled();
      expect((res.redirect as jest.Mock).mock.calls[0][0]).toBe(
        `${FRONTEND_URL}/login?error=oauth_state_mismatch`,
      );
    });

    it('state 일치 시 항상 oauth_state cookie 삭제 (한 번만 사용)', async () => {
      const user = makeUser();
      mockAuthService.findOrCreateKakaoUser.mockResolvedValue({
        user,
        isNew: false,
      });
      mockAuthService.issueTokens.mockResolvedValue({
        accessToken: 'a',
        refreshToken: 'r',
      });
      const req = makeValidCallbackReq({
        kakaoId: 'k',
        nickname: 'n',
        email: null,
      });
      const res = makeRes() as unknown as Response;
      await controller.kakaoCallback(req, res);
      expect(res.clearCookie).toHaveBeenCalledWith('oauth_state', {
        path: '/',
      });
    });
  });

  describe('kakaoCallback() — 인증 흐름 (state 통과 후)', () => {
    it('정상 활성 유저 → access_token 포함 프론트 URL로 리다이렉트', async () => {
      const user = makeUser();
      mockAuthService.findOrCreateKakaoUser.mockResolvedValue({
        user,
        isNew: false,
      });
      mockAuthService.issueTokens.mockResolvedValue({
        accessToken: 'access-token-value',
        refreshToken: 'refresh-token-value',
      });

      const req = makeValidCallbackReq({
        kakaoId: 'kakao-123',
        nickname: '테스트유저',
        email: null,
      });
      const res = makeRes() as unknown as Response;

      await controller.kakaoCallback(req, res);

      expect(res.cookie).toHaveBeenCalledWith(
        'refresh_token',
        'refresh-token-value',
        expect.any(Object),
      );
      const redirectUrl: string = (res.redirect as jest.Mock).mock.calls[0][0];
      // Fragment(#) 사용: server log·Referer에 token 미노출
      expect(redirectUrl).toContain(`${FRONTEND_URL}/login/callback#`);
      expect(redirectUrl).toContain('access_token=access-token-value');
      // query string에 token 없음 (fragment에만)
      expect(redirectUrl).not.toMatch(/\/login\/callback\?[^#]*access_token/);
    });

    it('정지된 유저 → /login?error=suspended 리다이렉트 (토큰 발급 안 함)', async () => {
      const suspendedUser = makeUser({ suspendedAt: new Date() });
      mockAuthService.findOrCreateKakaoUser.mockResolvedValue({
        user: suspendedUser,
        isNew: false,
      });

      const req = makeValidCallbackReq({
        kakaoId: 'kakao-123',
        nickname: '테스트유저',
        email: null,
      });
      const res = makeRes() as unknown as Response;

      await controller.kakaoCallback(req, res);

      expect(mockAuthService.issueTokens).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
      const redirectUrl: string = (res.redirect as jest.Mock).mock.calls[0][0];
      expect(redirectUrl).toBe(`${FRONTEND_URL}/login?error=suspended`);
    });

    it('정지된 어드민도 /login?error=suspended 리다이렉트', async () => {
      const suspendedAdmin = makeUser({
        role: 'admin',
        suspendedAt: new Date(),
      });
      mockAuthService.findOrCreateKakaoUser.mockResolvedValue({
        user: suspendedAdmin,
        isNew: false,
      });

      const req = makeValidCallbackReq({
        kakaoId: 'kakao-admin',
        nickname: '어드민',
        email: null,
      });
      const res = makeRes() as unknown as Response;

      await controller.kakaoCallback(req, res);

      expect(mockAuthService.issueTokens).not.toHaveBeenCalled();
      const redirectUrl: string = (res.redirect as jest.Mock).mock.calls[0][0];
      expect(redirectUrl).toBe(`${FRONTEND_URL}/login?error=suspended`);
    });

    it('신규 유저(termsAgreedAt=null)는 needs_terms=true로 리다이렉트', async () => {
      const newUser = makeUser({ termsAgreedAt: null });
      mockAuthService.findOrCreateKakaoUser.mockResolvedValue({
        user: newUser,
        isNew: true,
      });
      mockAuthService.issueTokens.mockResolvedValue({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });

      const req = makeValidCallbackReq({
        kakaoId: 'kakao-new',
        nickname: '신규',
        email: null,
      });
      const res = makeRes() as unknown as Response;

      await controller.kakaoCallback(req, res);

      const redirectUrl: string = (res.redirect as jest.Mock).mock.calls[0][0];
      expect(redirectUrl).toContain('needs_terms=true');
    });

    it('기존 유저(termsAgreedAt 있음)는 needs_terms=false로 리다이렉트', async () => {
      const existingUser = makeUser({ termsAgreedAt: new Date('2026-01-01') });
      mockAuthService.findOrCreateKakaoUser.mockResolvedValue({
        user: existingUser,
        isNew: false,
      });
      mockAuthService.issueTokens.mockResolvedValue({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });

      const req = makeValidCallbackReq({
        kakaoId: 'kakao-exist',
        nickname: '기존',
        email: null,
      });
      const res = makeRes() as unknown as Response;

      await controller.kakaoCallback(req, res);

      const redirectUrl: string = (res.redirect as jest.Mock).mock.calls[0][0];
      expect(redirectUrl).toContain('needs_terms=false');
    });
  });

  describe('refresh() — Refresh token rotation (LRR P1T1 M-1)', () => {
    const authenticatedUser = {
      id: 'user-uuid',
      nickname: '테스트유저',
      email: 'test@test.com',
      role: 'user',
      onboardedAt: null,
      termsAgreedAt: new Date('2026-01-01'),
      aiConsentAt: null,
      aiConsentVersion: null,
      onboardedCoinAt: null,
      suspendReason: null,
      suspendExpiresAt: null,
      pendingNotification: null,
    };

    it('refreshTokens 호출 + 새 refresh cookie set + accessToken/user 반환', async () => {
      mockAuthService.refreshTokens.mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
      });
      const res = makeRes() as unknown as Response;

      const result = await controller.refresh(authenticatedUser, res);

      // 새 access·refresh 둘 다 발급
      expect(mockAuthService.refreshTokens).toHaveBeenCalledWith('user-uuid');
      // 새 refresh를 cookie로 set (rotation 핵심)
      expect(res.cookie).toHaveBeenCalledWith(
        'refresh_token',
        'new-refresh',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: 30 * 24 * 60 * 60 * 1000,
        }),
      );
      // 응답 body 형식 유지 (frontend 변경 없음)
      expect(result).toEqual({
        accessToken: 'new-access',
        user: {
          id: 'user-uuid',
          nickname: '테스트유저',
          email: 'test@test.com',
          role: 'user',
          onboardedAt: null,
          termsAgreedAt: authenticatedUser.termsAgreedAt,
          aiConsentAt: null,
          aiConsentVersion: null,
          onboardedCoinAt: null,
        },
      });
    });

    it('refresh 응답에 refreshToken 평문 포함 X (cookie로만 전달)', async () => {
      mockAuthService.refreshTokens.mockResolvedValue({
        accessToken: 'a',
        refreshToken: 'r',
      });
      const res = makeRes() as unknown as Response;

      const result = await controller.refresh(authenticatedUser, res);

      expect(result).not.toHaveProperty('refreshToken');
    });
  });
});
