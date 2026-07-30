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

/**
 * `lastActiveAt` 갱신 최소 간격 = 표시 오차 상한.
 * 줄이면 정확해지고 DB 쓰기가 는다. 1분이면 "마지막 접속 시각"으로 충분하다.
 */
export const LAST_ACTIVE_THROTTLE_MS = 60_000;

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
    if (user.suspendedAt)
      throw new UnauthorizedException('계정이 정지되었습니다.');

    const now = new Date();

    /*
      ① 마지막 접속 시각 — 1분 throttle.

      전에는 "하루 1번"이었다. 그래서 저장된 값이 **그날 첫 접속 시각**이었고,
      admin 이 "마지막 접속"으로 읽는 값이 최대 하루까지 과거였다
      (2026-07-30 실측: 화면 17:15 / 실제 사용 22:38 — 5시간 23분 차이).

      1분으로 좁혀도 쓰기는 PK 단일 행 UPDATE 라, 활성 사용자 1명당 시간당 최대 60회다.
      1,000 DAU 가 하루 3시간씩 써도 초당 ~2회.

      ⚠️ 알려진 오차 — 이 값은 "사람이 있었다"가 아니라 "인증 요청이 왔다"이다.
      알림 배지가 5분마다 폴링하므로, 탭을 띄워둔 채 자리를 비우면 계속 갱신된다.
      "이 시각 이전에는 확실히 있었다"는 믿을 수 있고, "이 시각에 사람이 있었다"는 아니다.
    */
    if (
      now.getTime() - (user.lastActiveAt?.getTime() ?? 0) >=
      LAST_ACTIVE_THROTTLE_MS
    ) {
      this.userRepo.update(user.id, { lastActiveAt: now }).catch(() => {});
    }

    /*
      ② A8 — 일별 방문 기록 (코호트 리텐션·DAU 소스). best-effort, 인증 무영향.

      ① 과 **같은 if 에 묶여 있었는데 분리했다.** ① 이 1분 주기가 된 이상 같이 두면
      no-op INSERT 가 분당 한 번씩 날아간다. 이건 날짜 단위 지표라 날짜가 바뀔 때만 쓰면 된다.

      판정 기준은 여전히 `user.lastActiveAt` 이다 — 이 요청에서 읽은 **갱신 전** 값이라
      ① 이 먼저 써도 영향받지 않는다.
    */
    const todayKST = now.toLocaleDateString('en-CA', {
      timeZone: 'Asia/Seoul',
    });
    const lastKST = user.lastActiveAt?.toLocaleDateString('en-CA', {
      timeZone: 'Asia/Seoul',
    });
    if (lastKST !== todayKST) {
      this.userRepo.manager
        .query(
          `INSERT INTO user_daily_visits (user_id, visit_date)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [user.id, todayKST],
        )
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
