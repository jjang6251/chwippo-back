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

  async validate(req: Request, payload: { sub: string }) {
    const refreshToken = (req.cookies as Record<string, string>)?.[
      'refresh_token'
    ];
    if (!refreshToken) throw new UnauthorizedException();

    const user = await this.userRepo.findOne({ where: { id: payload.sub } });
    if (!user || user.refreshToken !== refreshToken)
      throw new UnauthorizedException();

    return {
      id: user.id,
      nickname: user.nickname,
      email: user.email,
      role: user.role,
      onboardedAt: user.onboardedAt ?? null,
    };
  }
}
