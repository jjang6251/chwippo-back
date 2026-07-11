import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'crypto';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { AppleAuthService } from './apple-auth.service';
import { AppleS2SService } from './apple-s2s.service';
import { KakaoNativeService } from './kakao-native.service';
import { AppleNativeLoginDto } from './dto/apple-native-login.dto';
import { deriveLoginProviders } from './login-providers.util';
import { AppleS2SNotificationDto } from './dto/apple-s2s-notification.dto';
import { KakaoNativeLoginDto } from './dto/kakao-native-login.dto';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ConfigService } from '@nestjs/config';

interface AuthenticatedUser {
  id: string;
  nickname: string;
  email: string | null;
  role: string;
  /** loginProviders 파생용 내부 필드 — raw 값은 응답에 미노출 */
  kakaoId?: string | null;
  appleSub?: string | null;
  onboardedAt: Date | null;
  termsAgreedAt: Date | null;
  aiConsentAt: Date | null;
  aiConsentVersion: string | null;
  /** PR_B1 — 코인 시스템 onboarding modal 표시 여부. NULL → modal 노출 */
  onboardedCoinAt: Date | null;
  /** W1 — signup 1 질문 답변. NULL → /signup/question redirect. [] → 답변 완료 (건너뛰기 포함) */
  signupJobCategories: string[] | null;
  /** W1 — "기타" 직군 자유 입력. NULL or "" → 미입력 */
  signupOtherText: string | null;
  /** W1 — 샘플 카드 전체 dismiss 시각. NULL → 샘플 살아있음 */
  sampleCardsDismissedAt: Date | null;
  /** 캘린더 UX 재구성 — "이제 캘린더가 홈이에요" 안내 배너 dismiss 시각. NULL → 첫 방문 배너 노출 */
  calendarHomeIntroDismissedAt: Date | null;
  /** 알림 — soft-ask 모달 표시 시각. NULL → native 최초 1회 모달 */
  alarmPromptedAt: Date | null;
}

interface KakaoCallbackUser {
  kakaoId: string;
  nickname: string;
  email: string | null;
}

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: 30 * 24 * 60 * 60 * 1000,
  path: '/',
};

// OAuth Login CSRF 방어용 nonce cookie (passport-kakao state 옵션 대체 — stateless 정책 유지)
const OAUTH_STATE_COOKIE = 'oauth_state';
const OAUTH_STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: 5 * 60 * 1000, // 5분 — 카카오 로그인 완료에 충분
  path: '/',
};

const KAKAO_AUTHORIZE_URL = 'https://kauth.kakao.com/oauth/authorize';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly appleAuthService: AppleAuthService,
    private readonly appleS2SService: AppleS2SService,
    private readonly kakaoNativeService: KakaoNativeService,
    private readonly config: ConfigService,
  ) {}

  /**
   * W2 RN 하이브리드 · Sign in with Apple (App Store Guideline 4.8) native 로그인.
   *
   * expo-apple-authentication signInAsync() 응답의 `identityToken` (JWT) 검증 후 우리 JWT 발급.
   * 첫 sign-in 시에만 fullName 옵셔널로 전달됨 (Apple 정책).
   *
   * refresh_token 은 web 과 동일하게 httpOnly cookie 로 · access_token 은 body.
   * mobile 은 SecureStore 로 access_token 저장 · cookie 는 axios 가 자동 관리.
   *
   * 429: 초당 10회 제한 (mobile 재시도 · brute force 방어).
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('apple/native')
  @HttpCode(HttpStatus.OK)
  async appleNativeLogin(
    @Body() dto: AppleNativeLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const payload = await this.appleAuthService.verifyIdentityToken(
      dto.identityToken,
    );
    const info = this.appleAuthService.extractUserInfo(payload, dto.fullName);
    const { user, isNew } =
      await this.appleAuthService.findOrCreateAppleUser(info);

    if (user.suspendedAt) {
      throw new ForbiddenException('정지된 계정입니다.');
    }

    const { accessToken, refreshToken } =
      await this.authService.issueTokens(user);

    res.cookie('refresh_token', refreshToken, REFRESH_COOKIE_OPTIONS);

    return {
      accessToken,
      isNew,
      user: {
        id: user.id,
        nickname: user.nickname,
        email: user.email,
        role: user.role,
        loginProviders: deriveLoginProviders(user),
        onboardedAt: user.onboardedAt,
        termsAgreedAt: user.termsAgreedAt,
        aiConsentAt: user.aiConsentAt,
      },
    };
  }

  /**
   * W2 RN · 카카오 네이티브 SDK 로그인.
   *
   * mobile 이 `@react-native-kakao/user` 로 획득한 access_token 을 서버가
   * Kakao `GET /v2/user/me` 로 검증 + 사용자 정보 조회 → 우리 JWT 발급.
   *
   * refresh_token 은 web 과 동일하게 httpOnly cookie 로 · access_token 은 body.
   *
   * 429: 초당 10회 제한 (재시도 · brute force 방어).
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('kakao/native')
  @HttpCode(HttpStatus.OK)
  async kakaoNativeLogin(
    @Body() dto: KakaoNativeLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const kakaoUser = await this.kakaoNativeService.verifyAndFetchUser(
      dto.accessToken,
    );
    const { user, isNew } =
      await this.authService.findOrCreateKakaoUser(kakaoUser);

    if (user.suspendedAt) {
      throw new ForbiddenException('정지된 계정입니다.');
    }

    const { accessToken, refreshToken } =
      await this.authService.issueTokens(user);

    res.cookie('refresh_token', refreshToken, REFRESH_COOKIE_OPTIONS);

    return {
      accessToken,
      isNew,
      user: {
        id: user.id,
        nickname: user.nickname,
        email: user.email,
        role: user.role,
        loginProviders: deriveLoginProviders(user),
        onboardedAt: user.onboardedAt,
        termsAgreedAt: user.termsAgreedAt,
        aiConsentAt: user.aiConsentAt,
      },
    };
  }

  /**
   * W2 RN · Sign in with Apple Server-to-Server Notifications (2026-01-01 필수).
   *
   * Apple 이 사용자 계정 이벤트를 우리 서버로 전송:
   *   - account-delete · consent-revoked → user 삭제 (or Kakao 병합 시 apple_sub 해제)
   *   - email-disabled · email-enabled → 로그만
   *
   * 인증 = payload JWT 의 Apple JWKS 서명 검증만 (public endpoint).
   * 항상 200 반환 (알 수 없는 sub 이든 실패든 · Apple 재시도 폭주 방지).
   *
   * 서명 자체 검증 실패는 401 로 반환 · Apple 이 재시도 (정상 흐름).
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post('apple/s2s-notification')
  @HttpCode(HttpStatus.OK)
  async appleS2SNotification(@Body() dto: AppleS2SNotificationDto) {
    const result = await this.appleS2SService.handleNotification(dto.payload);
    return { ok: true, result };
  }

  /**
   * 카카오 로그인 시작.
   * Login CSRF 방어를 위해 자체 nonce를 cookie에 저장하고 state 파라미터로 카카오에 전달.
   * 카카오는 state를 callback URL에 echo back — 우리가 cookie와 비교해 위변조 방어.
   * passport-kakao guard 대신 직접 redirect (passport state 옵션은 session 필요).
   */
  @Public()
  @Get('kakao')
  kakaoLogin(@Res() res: Response) {
    const nonce = randomBytes(32).toString('hex');
    res.cookie(OAUTH_STATE_COOKIE, nonce, OAUTH_STATE_COOKIE_OPTIONS);

    const clientId = this.config.getOrThrow<string>('KAKAO_CLIENT_ID');
    const redirectUri = this.config.getOrThrow<string>('KAKAO_REDIRECT_URI');
    const url =
      `${KAKAO_AUTHORIZE_URL}?` +
      `client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&state=${nonce}`;
    return res.redirect(url);
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Get('kakao/callback')
  @UseGuards(AuthGuard('kakao'))
  async kakaoCallback(@Req() req: Request, @Res() res: Response) {
    const frontendUrl = this.config.get<string>(
      'FRONTEND_URL',
      'http://localhost:5173',
    );

    // OAuth state 검증 — cookie nonce ↔ query state 일치 필수 (CSRF 방어)
    const cookieState = (req.cookies as Record<string, unknown> | undefined)?.[
      OAUTH_STATE_COOKIE
    ];
    const queryState = req.query.state;
    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' }); // 한 번만 사용
    if (
      typeof cookieState !== 'string' ||
      typeof queryState !== 'string' ||
      cookieState.length === 0 ||
      cookieState !== queryState
    ) {
      return res.redirect(`${frontendUrl}/login?error=oauth_state_mismatch`);
    }

    const kakaoUser = req.user as KakaoCallbackUser;
    const { user } = await this.authService.findOrCreateKakaoUser(kakaoUser);

    if (user.suspendedAt) {
      return res.redirect(`${frontendUrl}/login?error=suspended`);
    }

    const { accessToken, refreshToken } =
      await this.authService.issueTokens(user);

    res.cookie('refresh_token', refreshToken, REFRESH_COOKIE_OPTIONS);

    const params = new URLSearchParams({
      access_token: accessToken,
      needs_terms: String(!user.termsAgreedAt),
      user_id: user.id,
      user_nickname: user.nickname,
      user_role: user.role,
      ...(user.email ? { user_email: user.email } : {}),
      ...(user.termsAgreedAt
        ? { user_terms_agreed_at: user.termsAgreedAt.toISOString() }
        : {}),
      ...(user.onboardedAt
        ? { user_onboarded_at: user.onboardedAt.toISOString() }
        : {}),
    });
    // Fragment(#) 사용: server access log·Referer header에 token 미노출
    // (브라우저 history만 잔존 — 사용자 본인 디바이스라 신뢰 영역)
    return res.redirect(`${frontendUrl}/login/callback#${params.toString()}`);
  }

  @Public()
  // 60/min — 멀티탭·연속 reload·access token 만료 등 정상 사용 시나리오 여유.
  // Refresh는 유효한 cookie 필요해 brute force 무의미, IP 기반 한도는 abuse 방어용.
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @UseGuards(JwtRefreshGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Refresh token rotation (LRR P1T1 M-1) — 새 access·refresh 둘 다 발급
    const { accessToken, refreshToken } = await this.authService.refreshTokens(
      user.id,
    );
    res.cookie('refresh_token', refreshToken, REFRESH_COOKIE_OPTIONS);
    return {
      accessToken,
      user: {
        id: user.id,
        nickname: user.nickname,
        email: user.email,
        role: user.role,
        loginProviders: deriveLoginProviders({
          kakaoId: user.kakaoId ?? null,
          appleSub: user.appleSub ?? null,
        }),
        onboardedAt: user.onboardedAt ?? null,
        termsAgreedAt: user.termsAgreedAt ?? null,
        aiConsentAt: user.aiConsentAt ?? null,
        aiConsentVersion: user.aiConsentVersion ?? null,
        onboardedCoinAt: user.onboardedCoinAt ?? null,
        signupJobCategories: user.signupJobCategories ?? null,
        signupOtherText: user.signupOtherText ?? null,
        sampleCardsDismissedAt: user.sampleCardsDismissedAt ?? null,
        calendarHomeIntroDismissedAt: user.calendarHomeIntroDismissedAt ?? null,
        alarmPromptedAt: user.alarmPromptedAt ?? null,
      },
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logout(user.id);
    res.clearCookie('refresh_token', { path: '/' });
    return { message: '로그아웃 되었습니다.' };
  }
}
