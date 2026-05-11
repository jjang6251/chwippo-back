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

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get('kakao')
  @UseGuards(AuthGuard('kakao'))
  kakaoLogin() {
    // Passport가 카카오 로그인 페이지로 리다이렉트
  }

  @Public()
  @Get('kakao/callback')
  @UseGuards(AuthGuard('kakao'))
  async kakaoCallback(@Req() req: Request, @Res() res: Response) {
    const kakaoUser = req.user as KakaoCallbackUser;
    const { user, isNew } =
      await this.authService.findOrCreateKakaoUser(kakaoUser);
    const { accessToken, refreshToken } =
      await this.authService.issueTokens(user);

    res.cookie('refresh_token', refreshToken, REFRESH_COOKIE_OPTIONS);

    const frontendUrl = this.config.get<string>(
      'FRONTEND_URL',
      'http://localhost:5173',
    );
    const params = new URLSearchParams({
      access_token: accessToken,
      is_new: String(isNew),
      user_id: user.id,
      user_nickname: user.nickname,
      user_role: user.role,
      ...(user.email ? { user_email: user.email } : {}),
    });
    return res.redirect(`${frontendUrl}/login/callback?${params.toString()}`);
  }

  @Public()
  @UseGuards(JwtRefreshGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@CurrentUser() user: AuthenticatedUser) {
    const accessToken = await this.authService.refreshAccessToken(user.id);
    return {
      accessToken,
      user: {
        id: user.id,
        nickname: user.nickname,
        email: user.email,
        role: user.role,
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
