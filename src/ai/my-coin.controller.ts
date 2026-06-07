import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../users/user.entity';
import { CoinService } from './coin.service';
import { TierConfig } from './entities/tier-config.entity';

/**
 * PR_B1 — 본인 코인 정보 조회.
 *
 * **GET /me/coin-balance**:
 *   현재 balance + tier + next_reset_at + tier_config (한도·cap 등).
 *   신규 user (row 없음) → 자동 createInitialBalance 호출 후 150 반환.
 *
 * **POST /me/coin-onboarded**:
 *   onboarding modal 닫음 → users.onboarded_coin_at = NOW. 다음부터 modal 안 나옴.
 */
import { AllowSuspended } from '../common/decorators/allow-suspended.decorator';

// PR_B2 Phase 1 — me 호출 자체는 정지 user 도 허용 (SuspendedModal 표시 위해 상태 조회 필요)
@AllowSuspended()
@Controller('me')
@UseGuards(AuthGuard('jwt'))
export class MyCoinController {
  constructor(
    private readonly coinService: CoinService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(TierConfig)
    private readonly tierRepo: Repository<TierConfig>,
  ) {}

  @Get('coin-balance')
  async getBalance(@CurrentUser() user: { id: string }): Promise<{
    balance: number;
    tier: string;
    nextResetAt: Date;
    monthlyCoinLimit: number;
    companyResearchDailyCap: number;
    suspendedAt: Date | null;
    suspendReason: string | null;
    suspendExpiresAt: Date | null;
    pendingNotification: unknown;
  }> {
    const balanceInfo = await this.coinService.getBalanceWithLazyReset(user.id);
    const tierConfig = await this.tierRepo.findOne({
      where: { tier: balanceInfo.tier },
    });
    if (!tierConfig) {
      throw new Error(`tier_configs missing for ${balanceInfo.tier}`);
    }
    // balance row 다시 조회 — nextResetAt 가져옴
    const row = await this.coinService['balanceRepo'].findOne({
      where: { userId: user.id },
    });
    // PR_B2 Phase 1 — 사용자 정지 상태 + pending_notification (Q13 + Q24)
    const userRow = await this.userRepo.findOne({
      where: { id: user.id },
      select: [
        'id',
        'suspendedAt',
        'suspendReason',
        'suspendExpiresAt',
        'pendingNotification',
      ],
    });
    return {
      balance: balanceInfo.balance,
      tier: balanceInfo.tier,
      nextResetAt: row!.nextResetAt,
      monthlyCoinLimit: parseFloat(tierConfig.monthlyCoinLimit),
      companyResearchDailyCap: tierConfig.companyResearchDailyCap,
      suspendedAt: userRow?.suspendedAt ?? null,
      suspendReason: userRow?.suspendReason ?? null,
      suspendExpiresAt: userRow?.suspendExpiresAt ?? null,
      pendingNotification: userRow?.pendingNotification ?? null,
    };
  }

  @Post('coin-onboarded')
  async setOnboarded(
    @CurrentUser() user: { id: string },
  ): Promise<{ onboardedAt: Date }> {
    const now = new Date();
    await this.userRepo.update({ id: user.id }, { onboardedCoinAt: now });
    return { onboardedAt: now };
  }

  /**
   * PR_B2 Phase 1 — pending_notification dismiss (Q24).
   * 사용자가 모달 닫음 → DB NULL 처리. 다음 me 호출 시 표시 X.
   */
  @Post('notifications/dismiss')
  async dismissNotification(
    @CurrentUser() user: { id: string },
  ): Promise<{ ok: true }> {
    await this.userRepo.update({ id: user.id }, { pendingNotification: null });
    return { ok: true };
  }
}
