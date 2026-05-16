import {
  Controller,
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
  onboardedAt: Date | null;
  termsAgreedAt: Date | null;
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
    private readonly config: ConfigService,
  ) {}

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
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
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
        onboardedAt: user.onboardedAt ?? null,
        termsAgreedAt: user.termsAgreedAt ?? null,
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
