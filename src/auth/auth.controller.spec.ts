import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
// jose 는 ESM 전용 · Jest 는 CommonJS · apple-auth.service 가 jose import 하므로 mock 필수
jest.mock('jose', () => ({
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(() => jest.fn()),
}));

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AppleAuthService } from './apple-auth.service';
import { AppleS2SService } from './apple-s2s.service';
import { KakaoNativeService } from './kakao-native.service';
import { User } from '../users/user.entity';

const FRONTEND_URL = 'http://localhost:5173';
const KAKAO_CLIENT_ID = 'kakao-app-id';
const KAKAO_REDIRECT_URI = 'http://localhost:3000/auth/kakao/callback';
const VALID_STATE = 'a'.repeat(64); // 32바이트 hex
const APPLE_SERVICES_ID = 'com.chwippo.web';
const APPLE_WEB_REDIRECT_URI =
  'https://api.chwippo.com/auth/apple/web/callback';

// 웹 SIWA 전용 env — 테스트별로 세팅/삭제 (config.get 이 이 store 를 우선 조회)
const appleWebConfig: Record<string, string | undefined> = {};
function resetAppleWebConfig(): void {
  for (const key of Object.keys(appleWebConfig)) delete appleWebConfig[key];
}

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
    lastActiveAt: null,
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

function makeRes(): jest.Mocked<
  Pick<Response, 'redirect' | 'cookie' | 'clearCookie'>
> {
  return {
    redirect: jest.fn(),
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  } as jest.Mocked<Pick<Response, 'redirect' | 'cookie' | 'clearCookie'>>;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: { 'user-agent': 'jest-UA' },
    cookies: {},
    ...overrides,
  } as unknown as Request;
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
    headers: { 'user-agent': 'jest-UA' },
  } as unknown as Parameters<typeof AuthController.prototype.kakaoCallback>[0];
}

const mockAuthService = {
  findOrCreateKakaoUser: jest.fn(),
  issueTokens: jest.fn(),
  rotateTokens: jest.fn(),
  logout: jest.fn(),
};

const mockAppleAuthService = {
  verifyIdentityToken: jest.fn(),
  extractUserInfo: jest.fn(),
  findOrCreateAppleUser: jest.fn(),
  exchangeAndStoreRefreshToken: jest.fn().mockResolvedValue(undefined),
};

const mockAppleS2SService = {
  handleNotification: jest.fn(),
  verifyAndParse: jest.fn(),
};

const mockKakaoNativeService = {
  verifyAndFetchUser: jest.fn(),
};

const mockConfigService = {
  get: jest.fn().mockImplementation((key: string, defaultVal?: string) => {
    if (key === 'FRONTEND_URL') return FRONTEND_URL;
    if (key in appleWebConfig) return appleWebConfig[key];
    return defaultVal ?? '';
  }),
  getOrThrow: jest.fn().mockImplementation((key: string) => {
    if (key === 'KAKAO_CLIENT_ID') return KAKAO_CLIENT_ID;
    if (key === 'KAKAO_REDIRECT_URI') return KAKAO_REDIRECT_URI;
    if (key === 'APPLE_BUNDLE_ID') return 'com.chwippo.app';
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
        { provide: AppleAuthService, useValue: mockAppleAuthService },
        { provide: AppleS2SService, useValue: mockAppleS2SService },
        { provide: KakaoNativeService, useValue: mockKakaoNativeService },
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
      signupJobCategories: null,
      signupOtherText: null,
      sampleCardsDismissedAt: null,
      calendarHomeIntroDismissedAt: null,
      alarmPromptedAt: null,
      // 세션 지속성 — refresh 경로 전용 필드 (strategy 가 주입)
      sid: 'sid-1',
      refreshTokenRaw: 'raw-refresh',
    };

    it('rotateTokens 호출(sid+rawToken) + 새 refresh cookie set + accessToken/user 반환', async () => {
      mockAuthService.rotateTokens.mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
      });
      const res = makeRes() as unknown as Response;

      const result = await controller.refresh(
        authenticatedUser,
        makeReq(),
        res,
      );

      // 원자적 rotation — sid + rawToken + role 전달
      expect(mockAuthService.rotateTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-uuid',
          role: 'user',
          sid: 'sid-1',
          rawToken: 'raw-refresh',
        }),
      );
      // 새 refresh를 cookie로 set (rotation 핵심) — sliding 60일 동기화
      expect(res.cookie).toHaveBeenCalledWith(
        'refresh_token',
        'new-refresh',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: 60 * 24 * 60 * 60 * 1000,
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
          loginProviders: [],
          onboardedAt: null,
          termsAgreedAt: authenticatedUser.termsAgreedAt,
          aiConsentAt: null,
          aiConsentVersion: null,
          onboardedCoinAt: null,
          // W1 — signup 답변 + sample dismiss 추적
          signupJobCategories: null,
          signupOtherText: null,
          sampleCardsDismissedAt: null,
          calendarHomeIntroDismissedAt: null,
          alarmPromptedAt: null,
        },
      });
    });

    it('W1 — refresh 응답에 signup* + sampleCardsDismissedAt 포함 (이미 답변한 user)', async () => {
      mockAuthService.rotateTokens.mockResolvedValue({
        accessToken: 'a',
        refreshToken: 'r',
      });
      const res = makeRes() as unknown as Response;
      const answeredUser = {
        ...authenticatedUser,
        signupJobCategories: ['백엔드 개발', 'UI/UX·프로덕트 디자이너'],
        signupOtherText: null,
        sampleCardsDismissedAt: new Date('2026-06-27'),
      };

      const result = await controller.refresh(answeredUser, makeReq(), res);

      expect(result.user).toMatchObject({
        signupJobCategories: ['백엔드 개발', 'UI/UX·프로덕트 디자이너'],
        signupOtherText: null,
        sampleCardsDismissedAt: new Date('2026-06-27'),
      });
    });

    it('refresh 응답에 refreshToken 평문 포함 X (cookie로만 전달)', async () => {
      mockAuthService.rotateTokens.mockResolvedValue({
        accessToken: 'a',
        refreshToken: 'r',
      });
      const res = makeRes() as unknown as Response;

      const result = await controller.refresh(
        authenticatedUser,
        makeReq(),
        res,
      );

      expect(result).not.toHaveProperty('refreshToken');
    });
  });

  describe('logout() — 해당 세션만 삭제 (푸시-세션 분리)', () => {
    const authUser = { id: 'user-uuid' } as never;

    it('cookie refresh_token 을 rawToken 으로 logout 호출 + cookie clear', async () => {
      mockAuthService.logout.mockResolvedValue(undefined);
      const res = makeRes() as unknown as Response;
      const req = makeReq({ cookies: { refresh_token: 'raw-rt' } } as never);

      const result = await controller.logout(authUser, req, res);

      expect(mockAuthService.logout).toHaveBeenCalledWith(
        'user-uuid',
        'raw-rt',
      );
      expect(res.clearCookie).toHaveBeenCalledWith('refresh_token', {
        path: '/',
      });
      expect(result).toEqual({ message: '로그아웃 되었습니다.' });
    });

    it('cookie 없어도 logout 호출 (rawToken null) — 방어적', async () => {
      mockAuthService.logout.mockResolvedValue(undefined);
      const res = makeRes() as unknown as Response;

      await controller.logout(authUser, makeReq(), res);

      expect(mockAuthService.logout).toHaveBeenCalledWith('user-uuid', null);
    });
  });

  // ─── /auth/apple/native (W2 · SIWA) ─────────────────
  describe('appleNativeLogin() — Sign in with Apple', () => {
    const validPayload = {
      sub: 'apple-sub-1',
      aud: 'com.chwippo.app',
      iss: 'https://appleid.apple.com',
      email: 'user@icloud.com',
    };
    const userInfo = {
      appleSub: 'apple-sub-1',
      email: 'user@icloud.com',
      isPrivateEmail: false,
    };

    beforeEach(() => {
      mockAppleAuthService.verifyIdentityToken.mockResolvedValue(validPayload);
      mockAppleAuthService.extractUserInfo.mockReturnValue(userInfo);
      mockAppleAuthService.findOrCreateAppleUser.mockResolvedValue({
        user: makeUser({
          id: 'u-apple-1',
          appleSub: 'apple-sub-1',
          kakaoId: null,
        }),
        isNew: true,
      });
      mockAuthService.issueTokens.mockResolvedValue({
        accessToken: 'access.token',
        refreshToken: 'refresh.token',
      });
    });

    it('정상 → accessToken · isNew · user 반환 · refresh_token cookie 설정', async () => {
      const res = makeRes() as unknown as Response;

      const result = await controller.appleNativeLogin(
        { identityToken: 'valid.identity.token' },
        makeReq(),
        res,
      );

      expect(mockAppleAuthService.verifyIdentityToken).toHaveBeenCalledWith(
        'valid.identity.token',
      );
      expect(mockAppleAuthService.findOrCreateAppleUser).toHaveBeenCalledWith(
        userInfo,
      );
      expect(mockAuthService.issueTokens).toHaveBeenCalled();

      expect(result.accessToken).toBe('access.token');
      expect(result.isNew).toBe(true);
      expect(result.user).toMatchObject({
        id: 'u-apple-1',
        nickname: '테스트유저',
      });

      // refresh_token 은 cookie 로만 전달 · body 응답에 포함 X
      expect(result).not.toHaveProperty('refreshToken');

      const cookieCall = (res.cookie as jest.Mock).mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];
      expect(cookieCall[0]).toBe('refresh_token');
      expect(cookieCall[1]).toBe('refresh.token');
      expect(cookieCall[2]).toMatchObject({ httpOnly: true });
    });

    it('fullName 전달 시 extractUserInfo 로 forwarding', async () => {
      const res = makeRes() as unknown as Response;
      const fullName = { givenName: '길동', familyName: '홍' };

      await controller.appleNativeLogin(
        { identityToken: 'valid.token', fullName },
        makeReq(),
        res,
      );

      expect(mockAppleAuthService.extractUserInfo).toHaveBeenCalledWith(
        validPayload,
        fullName,
      );
    });

    it('기존 사용자 (isNew=false) 로그인 → isNew:false 반환', async () => {
      mockAppleAuthService.findOrCreateAppleUser.mockResolvedValue({
        user: makeUser({ appleSub: 'apple-sub-1', kakaoId: null }),
        isNew: false,
      });
      const res = makeRes() as unknown as Response;

      const result = await controller.appleNativeLogin(
        { identityToken: 'valid' },
        makeReq(),
        res,
      );

      expect(result.isNew).toBe(false);
    });

    it('정지된 계정 → ForbiddenException', async () => {
      mockAppleAuthService.findOrCreateAppleUser.mockResolvedValue({
        user: makeUser({
          appleSub: 'apple-sub-1',
          kakaoId: null,
          suspendedAt: new Date('2026-06-01'),
        }),
        isNew: false,
      });
      const res = makeRes() as unknown as Response;

      await expect(
        controller.appleNativeLogin({ identityToken: 'valid' }, makeReq(), res),
      ).rejects.toThrow('정지된 계정입니다.');

      // 정지된 사용자에게는 토큰 발급 X
      expect(mockAuthService.issueTokens).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it('verifyIdentityToken 실패 → 그대로 throw (controller 는 잡지 않음)', async () => {
      const err = new Error('Apple 로그인 검증 실패');
      mockAppleAuthService.verifyIdentityToken.mockRejectedValue(err);
      const res = makeRes() as unknown as Response;

      await expect(
        controller.appleNativeLogin({ identityToken: 'bad' }, makeReq(), res),
      ).rejects.toBe(err);
      expect(mockAppleAuthService.findOrCreateAppleUser).not.toHaveBeenCalled();
    });

    it('응답 user 에 refreshToken 필드 없음 (민감 정보 leak 방지)', async () => {
      const res = makeRes() as unknown as Response;

      const result = await controller.appleNativeLogin(
        { identityToken: 'valid' },
        makeReq(),
        res,
      );

      expect(result.user).not.toHaveProperty('refreshToken');
      expect(result.user).not.toHaveProperty('kakaoId');
      expect(result.user).not.toHaveProperty('appleSub');
    });
  });

  // ─── /auth/kakao/native (W2 · 카카오 네이티브 SDK) ─────
  describe('kakaoNativeLogin() — Kakao 네이티브 SDK', () => {
    const kakaoUser = {
      kakaoId: '123456789',
      nickname: '홍길동',
      email: 'foo@example.com',
    };

    beforeEach(() => {
      mockKakaoNativeService.verifyAndFetchUser.mockResolvedValue(kakaoUser);
      mockAuthService.findOrCreateKakaoUser.mockResolvedValue({
        user: makeUser({
          id: 'u-kakao-1',
          kakaoId: '123456789',
          nickname: '홍길동',
        }),
        isNew: true,
      });
      mockAuthService.issueTokens.mockResolvedValue({
        accessToken: 'access.token',
        refreshToken: 'refresh.token',
      });
    });

    it('정상 → accessToken · isNew · user 반환 · refresh_token cookie 설정', async () => {
      const res = makeRes() as unknown as Response;

      const result = await controller.kakaoNativeLogin(
        { accessToken: 'kakao-access-token' },
        makeReq(),
        res,
      );

      expect(mockKakaoNativeService.verifyAndFetchUser).toHaveBeenCalledWith(
        'kakao-access-token',
      );
      expect(mockAuthService.findOrCreateKakaoUser).toHaveBeenCalledWith(
        kakaoUser,
      );
      expect(result.accessToken).toBe('access.token');
      expect(result.isNew).toBe(true);
      expect(result.user.id).toBe('u-kakao-1');

      // refresh_token 은 cookie 로만
      expect(result).not.toHaveProperty('refreshToken');
      const cookieCall = (res.cookie as jest.Mock).mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];
      expect(cookieCall[0]).toBe('refresh_token');
      expect(cookieCall[2]).toMatchObject({ httpOnly: true });
    });

    it('기존 사용자 (isNew=false) → isNew:false 반환', async () => {
      mockAuthService.findOrCreateKakaoUser.mockResolvedValue({
        user: makeUser({ kakaoId: '123456789' }),
        isNew: false,
      });
      const res = makeRes() as unknown as Response;

      const result = await controller.kakaoNativeLogin(
        { accessToken: 'valid' },
        makeReq(),
        res,
      );

      expect(result.isNew).toBe(false);
    });

    it('정지된 계정 → ForbiddenException · 토큰 미발급', async () => {
      mockAuthService.findOrCreateKakaoUser.mockResolvedValue({
        user: makeUser({
          kakaoId: '123456789',
          suspendedAt: new Date('2026-06-01'),
        }),
        isNew: false,
      });
      const res = makeRes() as unknown as Response;

      await expect(
        controller.kakaoNativeLogin({ accessToken: 'valid' }, makeReq(), res),
      ).rejects.toThrow('정지된 계정입니다.');

      expect(mockAuthService.issueTokens).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it('verifyAndFetchUser 실패 → 그대로 throw · findOrCreate 미호출', async () => {
      const err = new Error('카카오 인증 실패');
      mockKakaoNativeService.verifyAndFetchUser.mockRejectedValue(err);
      const res = makeRes() as unknown as Response;

      await expect(
        controller.kakaoNativeLogin({ accessToken: 'bad' }, makeReq(), res),
      ).rejects.toBe(err);
      expect(mockAuthService.findOrCreateKakaoUser).not.toHaveBeenCalled();
    });

    it('응답 user 에 민감 정보 없음 (kakaoId · refreshToken)', async () => {
      const res = makeRes() as unknown as Response;

      const result = await controller.kakaoNativeLogin(
        { accessToken: 'valid' },
        makeReq(),
        res,
      );

      expect(result.user).not.toHaveProperty('kakaoId');
      expect(result.user).not.toHaveProperty('refreshToken');
    });
  });

  // ─── GET /auth/apple (웹 SIWA 시작) ────────────────────
  describe('appleWebLogin() — 웹 SIWA 시작', () => {
    afterEach(() => resetAppleWebConfig());

    it('SERVICES_ID·REDIRECT_URI 미설정 → apple_web_unavailable redirect · 쿠키 X', () => {
      const res = makeRes() as unknown as Response;

      controller.appleWebLogin(res);

      expect(res.cookie).not.toHaveBeenCalled();
      expect((res.redirect as jest.Mock).mock.calls[0][0]).toBe(
        `${FRONTEND_URL}/login?error=apple_web_unavailable`,
      );
    });

    it('REDIRECT_URI 만 설정(SERVICES_ID 없음) → unavailable', () => {
      appleWebConfig.APPLE_WEB_REDIRECT_URI = APPLE_WEB_REDIRECT_URI;
      const res = makeRes() as unknown as Response;

      controller.appleWebLogin(res);

      expect(res.cookie).not.toHaveBeenCalled();
      expect((res.redirect as jest.Mock).mock.calls[0][0]).toBe(
        `${FRONTEND_URL}/login?error=apple_web_unavailable`,
      );
    });

    it('SERVICES_ID·REDIRECT_URI 설정 → state 쿠키(SameSite=None·Secure) + Apple authorize redirect', () => {
      appleWebConfig.APPLE_SERVICES_ID = APPLE_SERVICES_ID;
      appleWebConfig.APPLE_WEB_REDIRECT_URI = APPLE_WEB_REDIRECT_URI;
      const res = makeRes() as unknown as Response;

      controller.appleWebLogin(res);

      const cookieCall = (res.cookie as jest.Mock).mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];
      expect(cookieCall[0]).toBe('apple_oauth_state');
      // 값 = "{state}.{nonce}" (각 32바이트 hex)
      expect(cookieCall[1]).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/);
      expect(cookieCall[2]).toEqual(
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'none',
          secure: true,
          path: '/',
        }),
      );

      const [state, nonce] = cookieCall[1].split('.');
      const redirectUrl = (res.redirect as jest.Mock).mock
        .calls[0][0] as string;
      expect(redirectUrl).toContain('https://appleid.apple.com/auth/authorize');
      expect(redirectUrl).toContain(
        `client_id=${encodeURIComponent(APPLE_SERVICES_ID)}`,
      );
      expect(redirectUrl).toContain('response_mode=form_post');
      expect(redirectUrl).toContain(`state=${state}`);
      expect(redirectUrl).toContain(`nonce=${nonce}`);
    });

    it('호출마다 state·nonce 새로 생성 (재사용 X)', () => {
      appleWebConfig.APPLE_SERVICES_ID = APPLE_SERVICES_ID;
      appleWebConfig.APPLE_WEB_REDIRECT_URI = APPLE_WEB_REDIRECT_URI;
      const res1 = makeRes() as unknown as Response;
      const res2 = makeRes() as unknown as Response;

      controller.appleWebLogin(res1);
      controller.appleWebLogin(res2);

      const v1 = (res1.cookie as jest.Mock).mock.calls[0][1] as string;
      const v2 = (res2.cookie as jest.Mock).mock.calls[0][1] as string;
      expect(v1).not.toBe(v2);
    });
  });

  // ─── POST /auth/apple/web/callback (웹 SIWA form_post 콜백) ──
  describe('appleWebCallback() — 웹 SIWA form_post 콜백', () => {
    const STATE = 'a'.repeat(64);
    const NONCE = 'b'.repeat(64);
    const applePayload = {
      sub: 'apple-sub-web-1',
      aud: APPLE_SERVICES_ID,
      iss: 'https://appleid.apple.com',
      email: 'web@icloud.com',
      nonce: NONCE,
    };
    const userInfo = {
      appleSub: 'apple-sub-web-1',
      email: 'web@icloud.com',
      isPrivateEmail: false,
    };

    function makeCallbackReq(
      body: Record<string, unknown>,
      cookieValue?: string,
    ): Request {
      return {
        body,
        cookies:
          cookieValue === undefined ? {} : { apple_oauth_state: cookieValue },
        headers: { 'user-agent': 'jest-UA' },
      } as unknown as Request;
    }

    beforeEach(() => {
      appleWebConfig.APPLE_SERVICES_ID = APPLE_SERVICES_ID;
      appleWebConfig.APPLE_WEB_REDIRECT_URI = APPLE_WEB_REDIRECT_URI;
      mockAppleAuthService.verifyIdentityToken.mockResolvedValue(applePayload);
      mockAppleAuthService.extractUserInfo.mockReturnValue(userInfo);
      mockAppleAuthService.findOrCreateAppleUser.mockResolvedValue({
        user: makeUser({
          id: 'u-web-1',
          appleSub: 'apple-sub-web-1',
          kakaoId: null,
        }),
        isNew: true,
      });
      mockAuthService.issueTokens.mockResolvedValue({
        accessToken: 'web.access.token',
        refreshToken: 'web.refresh.token',
      });
    });

    afterEach(() => resetAppleWebConfig());

    it('state 쿠키 없음 → oauth_state_mismatch · clearCookie(None·Secure) · verify 미호출', async () => {
      const res = makeRes() as unknown as Response;
      const req = makeCallbackReq({ state: STATE, id_token: 'tok' }); // 쿠키 없음

      await controller.appleWebCallback(req, res);

      expect(res.clearCookie).toHaveBeenCalledWith('apple_oauth_state', {
        path: '/',
        sameSite: 'none',
        secure: true,
      });
      expect(mockAppleAuthService.verifyIdentityToken).not.toHaveBeenCalled();
      expect(mockAppleAuthService.findOrCreateAppleUser).not.toHaveBeenCalled();
      expect((res.redirect as jest.Mock).mock.calls[0][0]).toBe(
        `${FRONTEND_URL}/login?error=oauth_state_mismatch`,
      );
    });

    it('state 불일치 → oauth_state_mismatch', async () => {
      const res = makeRes() as unknown as Response;
      const req = makeCallbackReq(
        { state: STATE, id_token: 'tok' },
        `different.${NONCE}`,
      );

      await controller.appleWebCallback(req, res);

      expect(mockAppleAuthService.verifyIdentityToken).not.toHaveBeenCalled();
      expect((res.redirect as jest.Mock).mock.calls[0][0]).toBe(
        `${FRONTEND_URL}/login?error=oauth_state_mismatch`,
      );
    });

    it('id_token 없음(state 통과) → apple_web_unavailable', async () => {
      const res = makeRes() as unknown as Response;
      const req = makeCallbackReq({ state: STATE }, `${STATE}.${NONCE}`);

      await controller.appleWebCallback(req, res);

      expect(mockAppleAuthService.verifyIdentityToken).not.toHaveBeenCalled();
      expect((res.redirect as jest.Mock).mock.calls[0][0]).toBe(
        `${FRONTEND_URL}/login?error=apple_web_unavailable`,
      );
    });

    it('SERVICES_ID 미설정(state·id_token 통과) → apple_web_unavailable', async () => {
      appleWebConfig.APPLE_SERVICES_ID = undefined;
      const res = makeRes() as unknown as Response;
      const req = makeCallbackReq(
        { state: STATE, id_token: 'tok' },
        `${STATE}.${NONCE}`,
      );

      await controller.appleWebCallback(req, res);

      expect(mockAppleAuthService.verifyIdentityToken).not.toHaveBeenCalled();
      expect((res.redirect as jest.Mock).mock.calls[0][0]).toBe(
        `${FRONTEND_URL}/login?error=apple_web_unavailable`,
      );
    });

    it('verifyIdentityToken throw → apple_web_unavailable', async () => {
      mockAppleAuthService.verifyIdentityToken.mockRejectedValue(
        new Error('Apple 로그인 검증 실패'),
      );
      const res = makeRes() as unknown as Response;
      const req = makeCallbackReq(
        { state: STATE, id_token: 'bad' },
        `${STATE}.${NONCE}`,
      );

      await controller.appleWebCallback(req, res);

      expect(mockAppleAuthService.findOrCreateAppleUser).not.toHaveBeenCalled();
      expect((res.redirect as jest.Mock).mock.calls[0][0]).toBe(
        `${FRONTEND_URL}/login?error=apple_web_unavailable`,
      );
    });

    it('nonce fail-closed — payload.nonce 누락 → oauth_state_mismatch', async () => {
      mockAppleAuthService.verifyIdentityToken.mockResolvedValue({
        ...applePayload,
        nonce: undefined,
      });
      const res = makeRes() as unknown as Response;
      const req = makeCallbackReq(
        { state: STATE, id_token: 'tok' },
        `${STATE}.${NONCE}`,
      );

      await controller.appleWebCallback(req, res);

      expect(mockAppleAuthService.findOrCreateAppleUser).not.toHaveBeenCalled();
      expect((res.redirect as jest.Mock).mock.calls[0][0]).toBe(
        `${FRONTEND_URL}/login?error=oauth_state_mismatch`,
      );
    });

    it('nonce 불일치 → oauth_state_mismatch', async () => {
      mockAppleAuthService.verifyIdentityToken.mockResolvedValue({
        ...applePayload,
        nonce: 'c'.repeat(64),
      });
      const res = makeRes() as unknown as Response;
      const req = makeCallbackReq(
        { state: STATE, id_token: 'tok' },
        `${STATE}.${NONCE}`,
      );

      await controller.appleWebCallback(req, res);

      expect(mockAppleAuthService.findOrCreateAppleUser).not.toHaveBeenCalled();
      expect((res.redirect as jest.Mock).mock.calls[0][0]).toBe(
        `${FRONTEND_URL}/login?error=oauth_state_mismatch`,
      );
    });

    it('쿠키 nonce 부분 누락(state만) → fail-closed mismatch', async () => {
      const res = makeRes() as unknown as Response;
      // 쿠키에 "." 없음 → cookieNonce undefined
      const req = makeCallbackReq({ state: STATE, id_token: 'tok' }, STATE);

      await controller.appleWebCallback(req, res);

      expect(mockAppleAuthService.findOrCreateAppleUser).not.toHaveBeenCalled();
      expect((res.redirect as jest.Mock).mock.calls[0][0]).toBe(
        `${FRONTEND_URL}/login?error=oauth_state_mismatch`,
      );
    });

    it('정상 → findOrCreate + issueTokens + fragment redirect + refresh 쿠키 + code 교환', async () => {
      const res = makeRes() as unknown as Response;
      const req = makeCallbackReq(
        { state: STATE, id_token: 'valid.id.token', code: 'auth-code-web' },
        `${STATE}.${NONCE}`,
      );

      await controller.appleWebCallback(req, res);

      // aud=SERVICES_ID 로 검증
      expect(mockAppleAuthService.verifyIdentityToken).toHaveBeenCalledWith(
        'valid.id.token',
        APPLE_SERVICES_ID,
      );
      // code → refresh_token 교환·저장 (services·redirectUri 전파)
      expect(
        mockAppleAuthService.exchangeAndStoreRefreshToken,
      ).toHaveBeenCalledWith(
        'u-web-1',
        'auth-code-web',
        APPLE_SERVICES_ID,
        APPLE_WEB_REDIRECT_URI,
      );
      expect(res.cookie).toHaveBeenCalledWith(
        'refresh_token',
        'web.refresh.token',
        expect.objectContaining({ httpOnly: true }),
      );
      const redirectUrl = (res.redirect as jest.Mock).mock
        .calls[0][0] as string;
      expect(redirectUrl).toContain(`${FRONTEND_URL}/login/callback#`);
      expect(redirectUrl).toContain('access_token=web.access.token');
      // 토큰은 fragment 에만 (query string 노출 X)
      expect(redirectUrl).not.toMatch(/\/login\/callback\?[^#]*access_token/);
    });

    it('code 없음 → 로그인 정상 · exchangeAndStore 미호출 (하위호환)', async () => {
      const res = makeRes() as unknown as Response;
      const req = makeCallbackReq(
        { state: STATE, id_token: 'valid.id.token' },
        `${STATE}.${NONCE}`,
      );

      await controller.appleWebCallback(req, res);

      expect(
        mockAppleAuthService.exchangeAndStoreRefreshToken,
      ).not.toHaveBeenCalled();
      const redirectUrl = (res.redirect as jest.Mock).mock
        .calls[0][0] as string;
      expect(redirectUrl).toContain(`${FRONTEND_URL}/login/callback#`);
    });

    it('정지된 계정 → suspended redirect · 토큰·code교환 미발생', async () => {
      mockAppleAuthService.findOrCreateAppleUser.mockResolvedValue({
        user: makeUser({
          id: 'u-web-susp',
          appleSub: 'apple-sub-web-1',
          kakaoId: null,
          suspendedAt: new Date('2026-06-01'),
        }),
        isNew: false,
      });
      const res = makeRes() as unknown as Response;
      const req = makeCallbackReq(
        { state: STATE, id_token: 'valid.id.token', code: 'x' },
        `${STATE}.${NONCE}`,
      );

      await controller.appleWebCallback(req, res);

      expect(mockAuthService.issueTokens).not.toHaveBeenCalled();
      expect(
        mockAppleAuthService.exchangeAndStoreRefreshToken,
      ).not.toHaveBeenCalled();
      expect((res.redirect as jest.Mock).mock.calls[0][0]).toBe(
        `${FRONTEND_URL}/login?error=suspended`,
      );
    });
  });
});
