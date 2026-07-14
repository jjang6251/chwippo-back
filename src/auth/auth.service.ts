import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import {
  DataSource,
  IsNull,
  MoreThan,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { User } from '../users/user.entity';
import { RefreshSession } from './refresh-session.entity';
import { RefreshToken } from './refresh-token.entity';
import { DiscordNotifier, DISCORD_COLORS } from '../common/discord-notifier';
import { returningRows } from '../common/db-returning';

/**
 * Refresh token을 DB에 저장하기 전 SHA-256 hex로 해싱.
 * - DB 유출 시 active refresh token 평문 노출 방지 (ADR-021 후속, LRR P1T1 M-2)
 * - JWT 자체가 200+자 고엔트로피라 rainbow table 무력화
 */
function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 세션 지속성 웨이브 (B안) — 튜닝 상수 (하드코딩 · 공격 표면 축소 A04) */
const SLIDING_DAYS = 60; // 정상 rotation 시 expires_at +60일
const ABSOLUTE_CAP_DAYS = 180; // created_at +180일 초과 시 rotation 거부
const MAX_SESSIONS_PER_USER = 10; // 기기 상한 (초과 시 최저 사용 세션 evict)
/**
 * 동시 경합 vs 탈취 구분 임계(초). 이미 소비된(used_at NOT NULL) 토큰이 다시 왔을 때:
 *  - used_at 이 이 임계 이내 → 정상 동시 요청 경합(멀티탭·RN resume·single-flight 경계).
 *    승자가 방금 만든 새 쿠키가 아직 반영 안 됐을 뿐 → 409 retry (세션 revoke 아님).
 *  - used_at 이 이 임계 초과 → 정상 클라이언트라면 이미 새 쿠키로 갈아탔을 시간.
 *    옛 토큰이 지금 오는 건 탈취 토큰 replay 로 간주 → 세션 revoke.
 * 5초 = 요청 왕복 + 클럭 스큐의 넉넉한 상한 (오탐 최소화, Auth0 reuse-interval leeway 개념).
 */
const CONCURRENCY_WINDOW_SECONDS = 5;
/** 소비된 refresh token 보존 기간(일) — cron 이 used_at +7일 경과분 삭제 (팽창 방지) */
const USED_TOKEN_RETENTION_DAYS = 7;

const SLIDING_MS = SLIDING_DAYS * 24 * 60 * 60 * 1000;
const ABSOLUTE_CAP_MS = ABSOLUTE_CAP_DAYS * 24 * 60 * 60 * 1000;
const CONCURRENCY_WINDOW_MS = CONCURRENCY_WINDOW_SECONDS * 1000;
const USED_TOKEN_RETENTION_MS = USED_TOKEN_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export interface KakaoUser {
  kakaoId: string;
  nickname: string;
  email: string | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface RotateParams {
  userId: string;
  role: string;
  /** refresh JWT `sid` claim — 없으면 구 토큰(sid 이전 발급) → 재로그인 유도(401) */
  sid?: string | null;
  /** cookie 의 평문 refresh JWT */
  rawToken: string;
  /** UA 문자열 (세션 표시용) */
  deviceInfo?: string | null;
}

/** rotation 조회 결과 (refresh_tokens ⋈ refresh_sessions) */
interface TokenRow {
  token_id: string;
  session_id: string;
  used_at: Date | null;
  session_created_at: Date;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(RefreshSession)
    private readonly sessionRepo: Repository<RefreshSession>,
    @InjectRepository(RefreshToken)
    private readonly tokenRepo: Repository<RefreshToken>,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly discord: DiscordNotifier,
    private readonly dataSource: DataSource,
  ) {}

  async findOrCreateKakaoUser(
    kakaoUser: KakaoUser,
  ): Promise<{ user: User; isNew: boolean }> {
    let user = await this.userRepo.findOne({
      where: { kakaoId: kakaoUser.kakaoId },
    });
    let isNew = !user;

    if (!user) {
      try {
        user = this.userRepo.create({
          kakaoId: kakaoUser.kakaoId,
          nickname: kakaoUser.nickname,
          email: kakaoUser.email,
        });
        user = await this.userRepo.save(user);
      } catch (err) {
        // Race condition: 동시 카카오 callback이 같은 ID로 save 시도
        // PostgreSQL unique violation code: 23505
        const isUniqueViolation =
          err instanceof QueryFailedError &&
          (
            err as QueryFailedError & {
              code?: string;
              driverError?: { code?: string };
            }
          ).driverError?.code === '23505';
        if (!isUniqueViolation) throw err;

        // 다른 요청이 먼저 INSERT 성공 → 그 user를 findOne으로 가져옴
        const existing = await this.userRepo.findOne({
          where: { kakaoId: kakaoUser.kakaoId },
        });
        if (!existing) throw err; // 정말로 사라졌으면 원본 에러 전파
        this.logger.warn(
          `findOrCreateKakaoUser race resolved (kakaoId=${kakaoUser.kakaoId})`,
        );
        user = existing;
        isNew = false;
      }
    }

    // ADMIN_KAKAO_ID 환경변수와 일치하면 자동으로 admin 승격
    // 직접 DB 쿼리 없이 첫 로그인 시점에만 적용 (이미 admin이면 스킵)
    const adminKakaoId = this.config.get<string>('ADMIN_KAKAO_ID');
    if (
      adminKakaoId &&
      user.kakaoId === adminKakaoId &&
      user.role !== 'admin'
    ) {
      await this.userRepo.update(user.id, { role: 'admin' });
      user.role = 'admin';
    }

    if (isNew) {
      void this.discord
        .notify(
          {
            title: '🎉 신규 가입',
            color: DISCORD_COLORS.green,
            fields: [
              { name: '경로', value: '카카오', inline: true },
              { name: 'userId', value: user.id, inline: true },
            ],
          },
          'growth',
        )
        .catch(() => undefined);
    }

    return { user, isNew };
  }

  private signAccessToken(userId: string, role: string): string {
    return this.jwtService.sign(
      { sub: userId, role },
      {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        expiresIn: this.config.get('JWT_EXPIRES_IN', '1h'),
      },
    );
  }

  private signRefreshToken(userId: string, role: string, sid: string): string {
    return this.jwtService.sign(
      // jti — 같은 세션·같은 초에 발급되는 두 토큰이 바이트 동일해져 token_hash UNIQUE 충돌(→500)하는 것 방지.
      // 발급 토큰마다 고유 hash 보장 (토큰 패밀리 row-per-token 전제).
      { sub: userId, role, sid, jti: randomUUID() },
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        // sliding 60일 세션과 동기화 (쿠키 maxAge 60d)
        expiresIn: this.config.get('JWT_REFRESH_EXPIRES_IN', '60d'),
      },
    );
  }

  /**
   * 로그인 — 새 기기 세션 발급 (매번 새 sid, session fixation 차단 CWE-384).
   *
   * - refresh JWT payload 에 `sid` claim 포함 · DB 엔 세션 1행 + 최초 토큰 1행 (hash 만 저장)
   * - 기기 상한 초과 시 최저 사용(expires_at 가장 오래된) 활성 세션 revoke
   * - 재로그인 시 session_expired_notified_at 리셋 (푸시 마스킹 해제)
   * - 세션 insert + 토큰 insert + evict + reset 을 1 트랜잭션으로 묶음
   */
  async issueTokens(
    user: User,
    deviceInfo?: string | null,
  ): Promise<TokenPair> {
    const sid = randomUUID();
    const tokenId = randomUUID();
    const accessToken = this.signAccessToken(user.id, user.role);
    const refreshToken = this.signRefreshToken(user.id, user.role, sid);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SLIDING_MS);

    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(RefreshSession).insert({
        id: sid,
        userId: user.id,
        createdAt: now,
        expiresAt,
        deviceInfo: deviceInfo?.slice(0, 255) ?? null,
        revokedAt: null,
      });
      await manager.getRepository(RefreshToken).insert({
        id: tokenId,
        sessionId: sid,
        tokenHash: hashRefreshToken(refreshToken),
        createdAt: now,
        usedAt: null,
      });
      await this.evictExcessSessions(manager, user.id);
      // 재로그인 → 만료-마스킹 상태 해제
      await manager.getRepository(User).update(user.id, {
        sessionExpiredNotifiedAt: null,
      });
    });

    return { accessToken, refreshToken };
  }

  /**
   * Refresh token rotation (B안 — 토큰 패밀리 · 정석 재사용 감지).
   *
   * 판정 흐름:
   *  1. presentedHash 로 refresh_tokens 조회 (session join · revoked_at IS NULL · user_id 스코프)
   *     - 없음 → 위조·만료·revoke·타유저 → 401
   *  2. used_at NOT NULL (이미 소비된 토큰 재사용) → 재조회 없이 판정
   *     - used_at 5초 이내 → 정상 경합 → 409 (RETRY) / 초과 → 명백한 탈취 → session revoke + 401
   *  3. absolute cap: session.created_at +180일 초과 → session revoke + 401
   *  4. used_at IS NULL (미사용) → 원자 UPDATE used_at=NOW WHERE used_at IS NULL RETURNING
   *     - 1행(승자) → 새 토큰 INSERT(같은 sid) + expires_at sliding +60d + 새 쌍 반환
   *     - 0행(방금 다른 요청이 선점) → 재조회 used_at 로 2번과 동일 판정 (경합 409 / 탈취 revoke+401)
   *  0. sid 없음(sid 이전 발급 구 토큰) → 세션 매핑 불가 → 재로그인 유도(401)
   *
   * 전 경로 (session.user_id = JWT sub) 스코프 유지 (BOLA A01/API1).
   */
  async rotateTokens(params: RotateParams): Promise<TokenPair> {
    const { userId, role, sid, rawToken } = params;
    const presentedHash = hashRefreshToken(rawToken);

    if (!sid) {
      throw new UnauthorizedException(); // sid 없는 구 토큰 = 세션 매핑 불가 → 재로그인
    }

    // 1. presentedHash 로 토큰 조회 (활성 세션 · user_id 스코프)
    const found: unknown = await this.tokenRepo.query(
      `SELECT t.id AS token_id, t.session_id, t.used_at,
              s.created_at AS session_created_at
         FROM refresh_tokens t
         JOIN refresh_sessions s ON s.id = t.session_id
        WHERE t.token_hash = $1 AND s.user_id = $2 AND s.revoked_at IS NULL
          AND s.expires_at > NOW()
        LIMIT 1`,
      [presentedHash, userId],
    );
    if (!Array.isArray(found) || found.length === 0) {
      throw new UnauthorizedException(); // 위조·만료·revoke·타유저
    }
    const row = found[0] as TokenRow;

    // 2. 이미 소비된 토큰 재사용 → 경합(409) or 탈취(revoke+401)
    if (row.used_at) {
      return this.rejectUsedToken(
        row.session_id,
        userId,
        new Date(row.used_at),
      );
    }

    // 3. absolute cap (created_at +180일 초과)
    if (
      new Date(row.session_created_at).getTime() <=
      Date.now() - ABSOLUTE_CAP_MS
    ) {
      await this.revokeSession(row.session_id, userId);
      this.logger.log(
        `[session] absolute cap 초과 — session ${row.session_id} user ${userId} 재로그인 유도`,
      );
      throw new UnauthorizedException();
    }

    // 4. 미사용 토큰 → 원자 소비 + 새 토큰 발급 (트랜잭션)
    const newRefreshToken = this.signRefreshToken(userId, role, sid);
    const newHash = hashRefreshToken(newRefreshToken);
    const newTokenId = randomUUID();
    let won = false;

    await this.dataSource.transaction(async (manager) => {
      const marked: unknown = await manager.query(
        `UPDATE refresh_tokens SET used_at = NOW()
          WHERE id = $1 AND used_at IS NULL
        RETURNING id`,
        [row.token_id],
      );
      if (returningRows(marked).length === 0) {
        return; // 방금 다른 요청이 선점 — tx 밖에서 재판정 (won=false)
      }
      won = true;
      await manager.query(
        `INSERT INTO refresh_tokens (id, session_id, token_hash, created_at, used_at)
         VALUES ($1, $2, $3, NOW(), NULL)`,
        [newTokenId, row.session_id, newHash],
      );
      await manager.query(
        `UPDATE refresh_sessions
            SET expires_at = NOW() + INTERVAL '${SLIDING_DAYS} days'
          WHERE id = $1 AND user_id = $2`,
        [row.session_id, userId],
      );
    });

    if (won) {
      return {
        accessToken: this.signAccessToken(userId, role),
        refreshToken: newRefreshToken,
      };
    }

    // 원자 UPDATE 0행 = 방금 다른 요청이 소비 → 재조회 후 경합/탈취 판정
    const reRead: unknown = await this.tokenRepo.query(
      `SELECT used_at FROM refresh_tokens WHERE id = $1`,
      [row.token_id],
    );
    const usedAt =
      Array.isArray(reRead) && reRead.length > 0
        ? ((reRead[0] as { used_at: Date | null }).used_at ?? null)
        : null;
    if (!usedAt) throw new UnauthorizedException(); // 재조회 실패 (극히 드묾)
    return this.rejectUsedToken(row.session_id, userId, new Date(usedAt));
  }

  /**
   * 이미 소비된(used_at NOT NULL) 토큰 재사용 처리 — 경합 vs 탈취 구분.
   *  - used_at 이 5초 이내 → 정상 동시 경합 → 409 (RETRY, 세션 유지)
   *  - 초과 → 명백한 탈취 replay → 세션 전체 revoke + audit + Discord critical + 401
   */
  private async rejectUsedToken(
    sessionId: string,
    userId: string,
    usedAt: Date,
  ): Promise<never> {
    const ageMs = Date.now() - usedAt.getTime();
    if (ageMs <= CONCURRENCY_WINDOW_MS) {
      // 정상 동시 요청 — 승자가 만든 새 쿠키 반영 후 재시도하면 성공
      throw new ConflictException({ code: 'RETRY' });
    }
    await this.handleReuse(sessionId, userId);
    throw new UnauthorizedException();
  }

  /** 세션(기기 체인) revoke — 그 세션의 refresh_tokens 전부 무효 (join 에서 revoked_at 차단). BOLA 스코프 */
  private async revokeSession(
    sessionId: string,
    userId: string,
  ): Promise<void> {
    await this.sessionRepo.query(
      `UPDATE refresh_sessions SET revoked_at = NOW()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [sessionId, userId],
    );
  }

  /** 재사용(탈취) 감지 — 해당 세션만 revoke + audit + Discord critical (타 기기 세션 생존) */
  private async handleReuse(sessionId: string, userId: string): Promise<void> {
    await this.revokeSession(sessionId, userId);
    this.logger.error(
      `[session] refresh token 재사용 감지 — session ${sessionId} user ${userId} revoke (탈취 가능성)`,
    );
    void this.discord
      .notify(
        {
          title: '🚨 Refresh token 재사용 감지',
          color: DISCORD_COLORS.red,
          fields: [
            { name: 'userId', value: userId, inline: true },
            { name: 'sessionId', value: sessionId, inline: true },
            {
              name: '조치',
              value: '해당 세션(기기 체인) revoke · 타 기기 세션 유지',
              inline: false,
            },
          ],
        },
        'critical',
      )
      .catch(() => undefined);
  }

  /**
   * 기기 상한 초과분 evict — 활성(revoked_at IS NULL) 세션이 상한 초과 시
   * 최저 사용(expires_at 가장 오래된) 세션 revoke. cron 이 이후 hard-delete.
   */
  private async evictExcessSessions(
    manager: { query: (sql: string, params: unknown[]) => Promise<unknown> },
    userId: string,
  ): Promise<void> {
    await manager.query(
      `UPDATE refresh_sessions SET revoked_at = NOW()
        WHERE user_id = $1 AND revoked_at IS NULL AND id NOT IN (
          SELECT id FROM refresh_sessions
          WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY expires_at DESC
          LIMIT $2
        )`,
      [userId, MAX_SESSIONS_PER_USER],
    );
  }

  /**
   * 명시적 로그아웃 — 제시된 토큰이 속한 세션(기기 체인)만 revoke (전체 아님).
   * 디바이스 토큰 제거는 기존 흐름 유지 (여기서 건드리지 않음).
   */
  async logout(userId: string, rawToken?: string | null): Promise<void> {
    if (rawToken) {
      const h = hashRefreshToken(rawToken);
      await this.sessionRepo.query(
        `UPDATE refresh_sessions SET revoked_at = NOW()
          WHERE user_id = $1 AND revoked_at IS NULL AND id IN (
            SELECT session_id FROM refresh_tokens WHERE token_hash = $2
          )`,
        [userId, h],
      );
    }
  }

  /**
   * 유효(만료 전·revoke 안 됨) 세션이 하나라도 있으면 true.
   * 푸시-세션 분리 판정용 (notification-dispatch 가 단일 호출).
   */
  async hasValidSession(
    userId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const count = await this.sessionRepo.count({
      where: { userId, expiresAt: MoreThan(now), revokedAt: IsNull() },
    });
    return count > 0;
  }

  /**
   * 만료·revoked 세션 정리 — cron 이 사용. 삭제 수 반환.
   * 토큰(refresh_tokens)은 FK ON DELETE CASCADE 로 함께 삭제.
   */
  async deleteExpiredSessions(now: Date = new Date()): Promise<number> {
    const rows: unknown = await this.sessionRepo.query(
      `DELETE FROM refresh_sessions
        WHERE expires_at < $1 OR revoked_at IS NOT NULL
      RETURNING id`,
      [now],
    );
    return returningRows(rows).length;
  }

  /**
   * 소비된 refresh token 정리 — cron 이 사용. used_at +7일 경과분 삭제 (팽창 방지).
   * 감지에 필요한 최근분만 유지 (7일 초과 옛 토큰 replay 는 세션 무효화 없이 401).
   */
  async deleteUsedTokens(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - USED_TOKEN_RETENTION_MS);
    const rows: unknown = await this.tokenRepo.query(
      `DELETE FROM refresh_tokens
        WHERE used_at IS NOT NULL AND used_at < $1
      RETURNING id`,
      [cutoff],
    );
    return returningRows(rows).length;
  }
}
