import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserCoinBalance } from './entities/user-coin-balance.entity';
import { UserPlanHistory } from './entities/user-plan-history.entity';
import { TierConfig, type CoinTier } from './entities/tier-config.entity';
import { CoinService } from './coin.service';

/**
 * PR_B1 — 사용자 plan / tier 변경 service.
 *
 * **호출자**:
 * - admin 페이지 (PR_B2) — `changeTier(userId, newTier, 'admin', adminId, reason)`
 * - 결제 인프라 (별도 PR) — `changeTier(userId, newTier, 'payment')`
 * - 자동 강등 (cron) — `expireDowngrade(userId, 'system')`
 *
 * **정책**:
 * - upgrade: 즉시 새 tier 적용 + balance reset (새 한도 부여) + next_reset = 부여일 + 30일
 * - downgrade: 현재 cycle 유지 (plan_expires_at 까지 기존 tier 한도). 자동 강등 cron 이 expire 시점에 free
 * - 같은 tier (no-op): history 안 남김
 *
 * **plan_history audit**: from_tier · to_tier · changed_by · changed_by_admin_id · reason · changed_at
 */
@Injectable()
export class UserCoinService {
  private readonly logger = new Logger(UserCoinService.name);

  constructor(
    @InjectRepository(UserCoinBalance)
    private readonly balanceRepo: Repository<UserCoinBalance>,
    @InjectRepository(UserPlanHistory)
    private readonly historyRepo: Repository<UserPlanHistory>,
    @InjectRepository(TierConfig)
    private readonly tierRepo: Repository<TierConfig>,
    private readonly coinService: CoinService,
  ) {}

  /**
   * Tier 변경. upgrade 는 즉시 새 한도 부여 / downgrade 는 cycle 유지.
   *
   * @returns 변경된 row 의 새 balance, tier, next_reset_at
   */
  async changeTier(
    userId: string,
    newTier: CoinTier,
    changedBy: 'system' | 'admin' | 'payment',
    changedByAdminId?: string | null,
    reason?: string | null,
  ): Promise<{ tier: CoinTier; balance: number; nextResetAt: Date }> {
    const balance = await this.balanceRepo.findOne({ where: { userId } });
    if (!balance) {
      // 신규 user — 자동 생성 후 변경
      await this.coinService.createInitialBalance(userId);
    }

    const current = await this.balanceRepo.findOne({ where: { userId } });
    if (!current)
      throw new NotFoundException('user_coin_balances row not found');
    const fromTier = current.tier;

    // 같은 tier — no-op
    if (fromTier === newTier) {
      return {
        tier: current.tier,
        balance: parseFloat(current.balance),
        nextResetAt: current.nextResetAt,
      };
    }

    const isUpgrade = this.isUpgrade(fromTier, newTier);
    if (isUpgrade) {
      // 즉시 새 한도 부여
      const newTierConfig = await this.tierRepo.findOne({
        where: { tier: newTier },
      });
      if (!newTierConfig)
        throw new NotFoundException(`tier_configs missing: ${newTier}`);
      const now = new Date();
      const planStartedAt = newTier !== 'free' ? now : null;
      const nextReset = this.coinService.calcNextResetAt(
        newTier,
        planStartedAt,
      );
      await this.balanceRepo.update(
        { userId },
        {
          tier: newTier,
          balance: newTierConfig.monthlyCoinLimit,
          cycleStartAt: now,
          nextResetAt: nextReset,
          planStartedAt,
          planExpiresAt: newTier !== 'free' ? nextReset : null,
        },
      );
    } else {
      // downgrade — 현재 cycle 유지. plan_expires_at 이 cron 또는 lazy 의 강등 기준
      await this.balanceRepo.update(
        { userId },
        {
          tier: newTier, // 표시는 새 tier
          // balance·next_reset_at 그대로 (현재 cycle 끝까지 기존 한도)
          planStartedAt: newTier !== 'free' ? current.planStartedAt : null,
          planExpiresAt:
            newTier === 'free' ? new Date() : current.planExpiresAt,
        },
      );
    }

    // history 기록
    await this.historyRepo.save(
      this.historyRepo.create({
        userId,
        fromTier,
        toTier: newTier,
        changedBy,
        changedByAdminId: changedByAdminId ?? null,
        reason: reason ?? null,
      }),
    );

    const updated = await this.balanceRepo.findOne({ where: { userId } });
    return {
      tier: updated!.tier,
      balance: parseFloat(updated!.balance),
      nextResetAt: updated!.nextResetAt,
    };
  }

  /** plan_expires_at 지난 user 자동 free 강등 (cron 호출) */
  async findExpiredPlans(): Promise<UserCoinBalance[]> {
    return this.balanceRepo
      .createQueryBuilder('b')
      .where('b.tier != :free', { free: 'free' })
      .andWhere('b.plan_expires_at IS NOT NULL')
      .andWhere('b.plan_expires_at < NOW()')
      .getMany();
  }

  /** plan 변경 history 조회 (admin) */
  async getHistory(userId: string): Promise<UserPlanHistory[]> {
    return this.historyRepo.find({
      where: { userId },
      order: { changedAt: 'DESC' },
      take: 50,
    });
  }

  /** Admin 코인 수동 지급 — balance += amount (양수만, 마이너스 보정용으로도 가능) */
  async grantCoin(
    userId: string,
    amount: number,
    adminId: string,
    reason: string,
  ): Promise<{ balance: number }> {
    const balance = await this.balanceRepo.findOne({ where: { userId } });
    if (!balance) {
      await this.coinService.createInitialBalance(userId);
    }
    await this.balanceRepo
      .createQueryBuilder()
      .update()
      .set({
        balance: () => `balance + ${amount}`,
      })
      .where('user_id = :userId', { userId })
      .execute();

    // history — to_tier 자체는 변경 X. 단 admin audit 용으로 별도 row
    // (단순성 위해 history 에 안 남기고 admin_audit_logs 에만 — PR_B2 에서 처리)
    this.logger.log(
      `Admin ${adminId} granted ${amount} coins to user ${userId}: ${reason}`,
    );

    const updated = await this.balanceRepo.findOne({ where: { userId } });
    return { balance: parseFloat(updated!.balance) };
  }

  // ─────────────────────────────────────
  // private
  // ─────────────────────────────────────

  private isUpgrade(from: CoinTier, to: CoinTier): boolean {
    const rank: Record<CoinTier, number> = { free: 0, lite: 1, standard: 2 };
    return rank[to] > rank[from];
  }
}
