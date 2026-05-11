import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import {
  ExtractJwt,
  Strategy,
  StrategyOptionsWithoutRequest,
} from 'passport-jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../users/user.entity';

export interface JwtPayload {
  sub: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {
    const opts: StrategyOptionsWithoutRequest = {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      ignoreExpiration: false,
    };
    super(opts);
  }

  async validate(payload: JwtPayload) {
    const user = await this.userRepo.findOne({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException();

    // 하루 1번만 갱신 (요청마다 쓰지 않도록)
    const todayKST = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Seoul',
    });
    const lastKST = user.lastActiveAt?.toLocaleDateString('en-CA', {
      timeZone: 'Asia/Seoul',
    });
    if (lastKST !== todayKST) {
      this.userRepo
        .update(user.id, { lastActiveAt: new Date() })
        .catch(() => {});
    }

    return {
      id: user.id,
      nickname: user.nickname,
      email: user.email,
      role: user.role,
    };
  }
}
