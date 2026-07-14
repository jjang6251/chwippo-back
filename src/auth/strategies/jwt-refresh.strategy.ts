import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, StrategyOptionsWithRequest } from 'passport-jwt';
import type { Request } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../users/user.entity';

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(
  Strategy,
  'jwt-refresh',
) {
  constructor(
    config: ConfigService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {
    const opts: StrategyOptionsWithRequest = {
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) =>
          (req?.cookies as Record<string, string>)?.['refresh_token'] ?? null,
      ]),
      secretOrKey: config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      ignoreExpiration: false,
      passReqToCallback: true,
    };
    super(opts);
  }

  async validate(
    req: Request,
    payload: { sub: string; sid?: string; role?: string },
  ) {
    const refreshToken = (req.cookies as Record<string, string>)?.[
      'refresh_token'
    ];
    if (!refreshToken) throw new UnauthorizedException();

    const user = await this.userRepo.findOne({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException();

    // 세션 지속성 웨이브(B안): token_hash 대조 + rotation 은 AuthService.rotateTokens 에서
    // 원자적으로 수행 (토큰 패밀리 재사용 감지). 여기선 서명·존재·정지만 검증하고
    // raw token + sid 를 controller 로 전달한다 (원자적 rotation 을 위해).
    if (user.suspendedAt)
      throw new UnauthorizedException('계정이 정지되었습니다.');

    return {
      // rotation 용 — controller → AuthService.rotateTokens 전달
      sid: payload.sid ?? null,
      refreshTokenRaw: refreshToken,
      id: user.id,
      nickname: user.nickname,
      email: user.email,
      role: user.role,
      // loginProviders 파생용 (컨트롤러가 배열로 변환 · raw 값은 응답에 미노출)
      kakaoId: user.kakaoId ?? null,
      appleSub: user.appleSub ?? null,
      onboardedAt: user.onboardedAt ?? null,
      termsAgreedAt: user.termsAgreedAt ?? null,
      aiConsentAt: user.aiConsentAt ?? null,
      aiConsentVersion: user.aiConsentVersion ?? null,
      // PR — refresh response 에 onboardedCoinAt 전달 (setOnboarded 후 새로고침 시 modal 재노출 차단)
      onboardedCoinAt: user.onboardedCoinAt ?? null,
      // W1 — signup answer + sample dismiss 추적 (signup-question redirect 분기 + 보드 dismiss bar)
      signupJobCategories: user.signupJobCategories ?? null,
      signupOtherText: user.signupOtherText ?? null,
      sampleCardsDismissedAt: user.sampleCardsDismissedAt ?? null,
      // 캘린더 UX 재구성 — 첫 방문 안내 배너 표시 여부 (NULL → 표시)
      calendarHomeIntroDismissedAt: user.calendarHomeIntroDismissedAt ?? null,
      // 알림 — soft-ask 모달 표시 여부 (NULL → native 에서 최초 1회 모달)
      alarmPromptedAt: user.alarmPromptedAt ?? null,
    };
  }
}
