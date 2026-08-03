import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RefreshSession } from '../auth/refresh-session.entity';
import { UserDevice } from '../devices/user-device.entity';
import { User } from '../users/user.entity';
import {
  APP_UA_MARKER,
  type PlatformSegment,
  type PlatformUsage,
  toSegment,
} from './user-platform';

export interface UserPlatformRow extends PlatformUsage {
  /** 푸시 토큰 보유 = 알림이 실제로 닿는다 (앱 사용 여부와 별개 — 권한 거부자는 앱이지만 여기 없음) */
  pushCapable: boolean;
}

export interface PlatformDistribution {
  total: number;
  both: number;
  appOnly: number;
  webOnly: number;
  none: number;
  /** 앱 사용자 중 푸시가 닿는 인원 */
  appUsers: number;
  pushCapable: number;
}

/**
 * 회원 사용 환경 조회 — **N+1 을 구조적으로 못 만들게** 배치 전용 API 만 노출한다.
 *
 * 🔴 **왜 "사용자 1명" 짜리 메서드를 안 만드나** — 만들어 두면 목록 렌더에서 `map` 안에 불려
 * 20명 목록에 쿼리 40개가 나간다. **단건 조회는 `getMany([id])` 로 배치 API 를 그대로 쓴다.**
 *
 * 쿼리 수는 **사용자 수와 무관하게 고정**이다:
 * - `getMany(ids)` → **2회** (세션 롤업 1 + 푸시 토큰 1)
 * - `getDistribution()` → **1회** (users LEFT JOIN 집계)
 *
 * 두 테이블 모두 `@Index(['userId'])` 가 있어 `user_id = ANY(...)` 가 인덱스를 탄다.
 */
@Injectable()
export class UserPlatformService {
  constructor(
    @InjectRepository(RefreshSession)
    private readonly sessionRepo: Repository<RefreshSession>,
    @InjectRepository(UserDevice)
    private readonly deviceRepo: Repository<UserDevice>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /**
   * 여러 사용자의 사용 환경을 한 번에. **쿼리 2회 고정.**
   *
   * 판정은 전체 로그인 이력 기준이다 (만료·폐기 세션 포함 — CEO 확정 2026-08-04).
   * ⚠️ 단 `SessionCleanupCron` 이 만료 세션을 삭제하므로 **보존 범위는 세션 수명까지**다
   * (60일+ 미접속자는 뱃지가 `미접속` 으로 되돌아간다). 근거·대안은 `user-platform.ts` 주석 참조.
   */
  async getMany(userIds: string[]): Promise<Map<string, UserPlatformRow>> {
    const result = new Map<string, UserPlatformRow>();
    if (userIds.length === 0) return result;

    // ① 세션 롤업 — 사용자당 1행으로 접어서 가져온다 (행 전체를 끌어오면 이력이 많은 유저에서 폭증)
    const sessions = await this.sessionRepo
      .createQueryBuilder('s')
      .select('s.user_id', 'userId')
      .addSelect(`bool_or(s.device_info ILIKE :marker)`, 'hasApp')
      .addSelect(
        `bool_or(s.device_info IS NOT NULL AND s.device_info NOT ILIKE :marker)`,
        'hasWeb',
      )
      .where('s.user_id IN (:...userIds)', { userIds })
      .setParameter('marker', `%${APP_UA_MARKER}%`)
      .groupBy('s.user_id')
      .getRawMany<{ userId: string; hasApp: boolean; hasWeb: boolean }>();

    // ② 푸시 토큰 보유 — 존재 여부만 필요하므로 역시 사용자당 1행
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
    for (const s of sessions) {
      const row = result.get(s.userId);
      if (row) {
        row.app = s.hasApp;
        row.web = s.hasWeb;
      }
    }
    return result;
  }

  /**
   * 전체 분포 — **쿼리 1회.**
   *
   * 🔴 `users` 에서 시작해 LEFT JOIN 한다. 세션 테이블에서 시작하면 **로그인한 적 없는 회원이
   * 통째로 빠져** 합계가 전체 인원과 안 맞는다 (`none` 이 0 으로 나온다).
   */
  async getDistribution(): Promise<PlatformDistribution> {
    // 🔴 **두 테이블을 users 에 직접 LEFT JOIN 하면 안 된다** — 세션 N개 × 기기 M개로
    //    사용자당 N×M 행이 부풀어(카테시안) 이력이 쌓일수록 조용히 느려진다.
    //    `bool_or`·`COUNT>0` 은 중복에 강해 **결과는 맞지만 비용만 커지는** 형태라 더 늦게 발견된다.
    //    각 테이블을 **사용자당 1행으로 먼저 접은 뒤** 조인해 부풀림 자체를 없앤다.
    const raw = await this.userRepo.query<
      Array<{
        userId: string;
        hasApp: boolean;
        hasWeb: boolean;
        pushCapable: boolean;
      }>
    >(
      `SELECT u.id AS "userId",
              COALESCE(s.has_app, false)      AS "hasApp",
              COALESCE(s.has_web, false)      AS "hasWeb",
              COALESCE(d.has_device, false)   AS "pushCapable"
         FROM users u
         LEFT JOIN (
           SELECT user_id,
                  bool_or(device_info ILIKE $1) AS has_app,
                  bool_or(device_info IS NOT NULL AND device_info NOT ILIKE $1) AS has_web
             FROM refresh_sessions
            GROUP BY user_id
         ) s ON s.user_id = u.id
         LEFT JOIN (
           SELECT user_id, true AS has_device FROM user_devices GROUP BY user_id
         ) d ON d.user_id = u.id`,
      [`%${APP_UA_MARKER}%`],
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
      const seg: PlatformSegment = toSegment({ app: r.hasApp, web: r.hasWeb });
      if (seg === 'both') dist.both += 1;
      else if (seg === 'app_only') dist.appOnly += 1;
      else if (seg === 'web_only') dist.webOnly += 1;
      else dist.none += 1;

      if (r.hasApp) {
        dist.appUsers += 1;
        if (r.pushCapable) dist.pushCapable += 1;
      }
    }
    return dist;
  }
}
