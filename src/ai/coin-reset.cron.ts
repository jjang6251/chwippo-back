import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CoinService } from './coin.service';
import { UserCoinService } from './user-coin.service';

/**
 * PR_B1 — 매일 자정 KST 코인 reset cron.
 *
 * **두 단계**:
 * 1. expired plan downgrade — plan_expires_at < NOW 인 유료 user → free 강등
 * 2. due reset — next_reset_at < NOW 인 user → balance reset (마이너스 carry)
 *
 * **lazy 보조**: 호출 시점 lazy reset 이 primary. cron 은 inactive user 의 UI chip 정확성 보장.
 *
 * **실패 처리**: 1회 시도. 한 user 의 reset 실패는 logger.warn 만 (다른 user 영향 X).
 *   다음 자정 자연 retry. 또는 lazy 호출 시 자동 처리.
 */
@Injectable()
export class CoinResetCron {
  private readonly logger = new Logger(CoinResetCron.name);

  constructor(
    private readonly coinService: CoinService,
    private readonly userCoinService: UserCoinService,
  ) {}

  @Cron('0 0 * * *', { timeZone: 'Asia/Seoul' })
  async runDaily(): Promise<void> {
    this.logger.log('[CoinResetCron] daily reset 시작 (KST 0시)');
    let expiredCount = 0;
    let resetCount = 0;
    let errorCount = 0;

    // 1. expired plan downgrade
    const expired = await this.userCoinService
      .findExpiredPlans()
      .catch((err) => {
        this.logger.error(`findExpiredPlans 실패: ${(err as Error).message}`);
        return [];
      });
    for (const row of expired) {
      try {
        await this.userCoinService.changeTier(
          row.userId,
          'free',
          'system',
          null,
          '자동 강등 — plan_expires_at 도달',
        );
        expiredCount++;
      } catch (err) {
        errorCount++;
        this.logger.warn(
          `expired downgrade 실패 (user=${row.userId}): ${(err as Error).message}`,
        );
      }
    }

    // 2. due reset
    const due = await this.coinService.findDueResets().catch((err) => {
      this.logger.error(`findDueResets 실패: ${(err as Error).message}`);
      return [];
    });
    for (const row of due) {
      try {
        await this.coinService.reset(row.userId);
        resetCount++;
      } catch (err) {
        errorCount++;
        this.logger.warn(
          `reset 실패 (user=${row.userId}): ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `[CoinResetCron] 완료 — expired downgrade ${expiredCount} / reset ${resetCount} / error ${errorCount}`,
    );
  }
}
