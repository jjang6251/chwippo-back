import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserDevice } from '../devices/user-device.entity';
import { User } from '../users/user.entity';
import {
  classifyLoginStamps,
  type PlatformSegment,
  type PlatformUsage,
  toSegment,
} from './user-platform';

export interface UserPlatformRow extends PlatformUsage {
  /** 푸시 토큰 보유 = 알림이 실제로 닿는다. 앱 사용과 **별개 축**(권한 거부자는 app=true·false) */
  pushCapable: boolean;
}

export interface PlatformDistribution {
  total: number;
  both: number;
  appOnly: number;
  webOnly: number;
  none: number;
  /** 앱 사용자 = appOnly + both */
  appUsers: number;
  /** 그중 푸시가 닿는 인원 */
  pushCapable: number;
}

/**
 * 회원 사용 환경 조회 — **N+1 을 구조적으로 못 만들게** 배치 전용 API 만 노출한다.
 *
 * 🔴 **"사용자 1명" 짜리 메서드를 만들지 않는다** — 있으면 목록 렌더의 `map` 안에 불려
 * 20명 목록에 쿼리가 20배로 나간다. **단건 조회도 `getMany([id])` 로 배치 API 를 그대로 쓴다.**
 *
 * 판정 근거가 `users` 컬럼으로 옮겨오면서 **세션 조인이 사라졌다** (2026-08-04) —
 * 쿼리가 줄고, 세션 정리 cron 에 판정이 휘둘리던 문제도 함께 해소됐다.
 *
 * 쿼리 수는 **사용자 수와 무관하게 고정**:
 * - `getMany(ids)` → **2회** (users 스탬프 1 + 푸시 토큰 1)
 * - `getDistribution()` → **1회**
 */
@Injectable()
export class UserPlatformService {
  constructor(
    @InjectRepository(UserDevice)
    private readonly deviceRepo: Repository<UserDevice>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /** 여러 사용자의 사용 환경을 한 번에. **쿼리 2회 고정.** */
  async getMany(userIds: string[]): Promise<Map<string, UserPlatformRow>> {
    const result = new Map<string, UserPlatformRow>();
    if (userIds.length === 0) return result;

    const users = await this.userRepo
      .createQueryBuilder('u')
      .select('u.id', 'id')
      .addSelect('u.first_app_login_at', 'appAt')
      .addSelect('u.first_web_login_at', 'webAt')
      .where('u.id IN (:...userIds)', { userIds })
      .getRawMany<{ id: string; appAt: Date | null; webAt: Date | null }>();

    // 존재 여부만 필요하므로 사용자당 1행으로 접는다
    const devices = await this.deviceRepo
      .createQueryBuilder('d')
      .select('d.user_id', 'userId')
      .where('d.user_id IN (:...userIds)', { userIds })
      .groupBy('d.user_id')
      .getRawMany<{ userId: string }>();
    const pushSet = new Set(devices.map((d) => d.userId));

    for (const id of userIds) {
      result.set(id, { app: false, web: false, pushCapable: pushSet.has(id) });
    }
    for (const u of users) {
      const row = result.get(u.id);
      if (row) Object.assign(row, classifyLoginStamps(u.appAt, u.webAt));
    }
    return result;
  }

  /**
   * 전체 분포 — **쿼리 1회.**
   *
   * 🔴 `users` 에서 시작한다. 다른 테이블에서 시작하면 **로그인한 적 없는 회원이 통째로 빠져**
   * 합계가 전체 인원과 안 맞는다 (`none` 이 0 으로 나온다).
   *
   * `user_devices` 는 **사용자당 1행으로 먼저 접은 뒤** 조인한다 — 그냥 조인하면 기기 수만큼
   * 행이 부푼다. `COUNT>0` 은 중복에 강해 **결과는 맞고 비용만 커지는** 형태라 늦게 발견된다.
   */
  async getDistribution(): Promise<PlatformDistribution> {
    const raw = await this.userRepo.query<
      Array<{
        appAt: Date | null;
        webAt: Date | null;
        pushCapable: boolean;
      }>
    >(
      `SELECT u.first_app_login_at        AS "appAt",
              u.first_web_login_at        AS "webAt",
              COALESCE(d.has_device, false) AS "pushCapable"
         FROM users u
         LEFT JOIN (
           SELECT user_id, true AS has_device FROM user_devices GROUP BY user_id
         ) d ON d.user_id = u.id`,
    );

    const dist: PlatformDistribution = {
      total: raw.length,
      both: 0,
      appOnly: 0,
      webOnly: 0,
      none: 0,
      appUsers: 0,
      pushCapable: 0,
    };

    for (const r of raw) {
      const usage = classifyLoginStamps(r.appAt, r.webAt);
      const seg: PlatformSegment = toSegment(usage);
      if (seg === 'both') dist.both += 1;
      else if (seg === 'app_only') dist.appOnly += 1;
      else if (seg === 'web_only') dist.webOnly += 1;
      else dist.none += 1;

      if (usage.app) {
        dist.appUsers += 1;
        if (r.pushCapable) dist.pushCapable += 1;
      }
    }
    return dist;
  }
}
