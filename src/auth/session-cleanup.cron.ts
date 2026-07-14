import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AuthService } from './auth.service';

/**
 * 세션 지속성 웨이브 (B안) — refresh 세션·소비 토큰 정리 cron (일 1회 04:30 KST).
 *
 *  1. 만료(`expires_at < NOW`) 또는 revoked(`revoked_at IS NOT NULL`) 세션 삭제
 *     — 토큰은 FK CASCADE 로 함께 정리 (CWE-613 만료 세션 방치 방지).
 *  2. 소비된 토큰(`used_at +7일` 경과) 삭제 — 테이블 팽창 방지, 최근분만 감지에 유지.
 *
 * lazy 정리(rotation 시 cap/만료/재사용 처리)의 backup. 삭제 수 로그.
 */
@Injectable()
export class SessionCleanupCron {
  private readonly logger = new Logger(SessionCleanupCron.name);

  constructor(private readonly authService: AuthService) {}

  @Cron('30 4 * * *', { timeZone: 'Asia/Seoul' })
  async sweep(): Promise<void> {
    try {
      const sessions = await this.authService.deleteExpiredSessions();
      const tokens = await this.authService.deleteUsedTokens();
      this.logger.log(
        `[SessionCleanupCron] 만료·revoked 세션 ${sessions}건 · 소비 토큰 ${tokens}건 정리`,
      );
    } catch (err) {
      this.logger.error(
        `[SessionCleanupCron] 정리 실패: ${(err as Error).message}`,
      );
    }
  }
}
