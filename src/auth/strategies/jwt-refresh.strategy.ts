import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, StrategyOptionsWithRequest } from 'passport-jwt';
import { createHash } from 'crypto';
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

  async validate(req: Request, payload: { sub: string }) {
    const refreshToken = (req.cookies as Record<string, string>)?.[
      'refresh_token'
    ];
    if (!refreshToken) throw new UnauthorizedException();

    const user = await this.userRepo.findOne({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException();

    // DB엔 hash 저장 → cookie의 평문 JWT를 hash해서 비교 (LRR P1T1 M-2)
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
    if (user.refreshToken !== tokenHash) throw new UnauthorizedException();

    if (user.suspendedAt)
      throw new UnauthorizedException('계정이 정지되었습니다.');

    return {
      id: user.id,
      nickname: user.nickname,
      email: user.email,
      role: user.role,
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
    };
  }
}
