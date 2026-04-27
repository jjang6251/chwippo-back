import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-kakao';

export interface KakaoProfile {
  id: number;
  username: string;
  _json: {
    kakao_account?: {
      email?: string;
      profile?: { nickname?: string };
    };
  };
}

@Injectable()
export class KakaoStrategy extends PassportStrategy(Strategy, 'kakao') {
  constructor(config: ConfigService) {
    super({
      clientID: config.getOrThrow<string>('KAKAO_CLIENT_ID'),
      clientSecret: config.getOrThrow<string>('KAKAO_CLIENT_SECRET'),
      callbackURL: config.getOrThrow<string>('KAKAO_REDIRECT_URI'),
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: KakaoProfile,
    done: (err: unknown, user: unknown) => void,
  ) {
    const kakaoAccount = profile._json.kakao_account;
    done(null, {
      kakaoId: String(profile.id),
      nickname: kakaoAccount?.profile?.nickname ?? `user_${profile.id}`,
      email: kakaoAccount?.email ?? null,
    });
  }
}
