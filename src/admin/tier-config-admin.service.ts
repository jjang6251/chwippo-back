import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { TierConfig, type CoinTier } from '../ai/entities/tier-config.entity';
import { UserCoinBalance } from '../ai/entities/user-coin-balance.entity';
import { AdminAuditService } from './admin-audit.service';
import { UpdateTierConfigDto } from './dto/update-tier-config.dto';
import { returningRows } from '../common/db-returning';

/**
 * PR_B2 Phase 3 — tier_configs 매트릭스 수정 (Q3 C admin 선택 + confirm UI 전제).
 *
 * 정책:
 * - applyMode='immediate' → user_coin_balances 의 해당 tier 모든 row 의 balance 즉시 변경 (diff)
 * - applyMode='next_reset' → tier_configs 만 update. CoinResetCron 다음 사이클부터 자동 적용
 * - 모든 액션 = TX + audit `update_tier_config` (before/after/applyMode/affectedUsers) + IP/UA
 *
 * S2 (운영 사고 시뮬) 대비 — applyMode=immediate + 큰 diff 시 frontend 가 affectedUsers preview 강제.
 */
@Injectable()
export class TierConfigAdminService {
  constructor(
    @InjectRepository(TierConfig)
    private readonly tierRepo: Repository<TierConfig>,
    @InjectRepository(UserCoinBalance)
    private readonly balanceRepo: Repository<UserCoinBalance>,
    private readonly dataSource: DataSource,
    private readonly auditService: AdminAuditService,
  ) {}

  async listAll(): Promise<TierConfig[]> {
    return await this.tierRepo.find({ order: { tier: 'ASC' } });
  }

  async getOne(tier: CoinTier): Promise<TierConfig> {
    const row = await this.tierRepo.findOne({ where: { tier } });
    if (!row) {
      throw new NotFoundException(`tier_config 가 없습니다: ${tier}`);
    }
    return row;
  }

  /**
   * preview — 변경 전 affectedUsers + sample (Q3 C confirm UI 용).
   */
  async getPreview(tier: CoinTier): Promise<{
    affectedUsers: number;
    sample: Array<{ userId: string; balance: number }>;
  }> {
    const [count, sample] = await Promise.all([
      this.balanceRepo.count({ where: { tier } }),
      this.balanceRepo.find({
        where: { tier },
        select: ['userId', 'balance'],
        take: 10,
        order: { updatedAt: 'DESC' },
      }),
    ]);
    return {
      affectedUsers: count,
      sample: sample.map((s) => ({
        userId: s.userId,
        balance: Number(s.balance),
      })),
    };
  }

  /**
   * PR_B2 Phase 3 — tier_config 수정. applyMode 별로:
   * - immediate: monthly_coin_limit diff 만큼 user 전체 balance 즉시 ±
   * - next_reset: tier_configs 만 UPDATE
   */
  async updateTierConfig(
    adminId: string,
    tier: CoinTier,
    dto: UpdateTierConfigDto,
    ctx?: { ip?: string | null; userAgent?: string | null },
  ): Promise<{ updated: TierConfig; affectedUsers: number }> {
    return await this.dataSource.transaction(async (manager) => {
      const before = await manager.findOne(TierConfig, {
        where: { tier },
        lock: { mode: 'pessimistic_write' },
      });
      if (!before) {
        throw new NotFoundException(`tier_config 가 없습니다: ${tier}`);
      }

      // partial update
      const after = manager.create(TierConfig, {
        ...before,
        ...(dto.monthlyCoinLimit !== undefined && {
          monthlyCoinLimit: dto.monthlyCoinLimit.toFixed(1),
        }),
        ...(dto.inputTokenCapPerCall !== undefined && {
          inputTokenCapPerCall: dto.inputTokenCapPerCall,
        }),
        ...(dto.defaultCooldownSeconds !== undefined && {
          defaultCooldownSeconds: dto.defaultCooldownSeconds,
        }),
        ...(dto.noteSummaryCooldownMinutes !== undefined && {
          noteSummaryCooldownMinutes: dto.noteSummaryCooldownMinutes,
        }),
        ...(dto.priceKrw !== undefined && { priceKrw: dto.priceKrw }),
        ...(dto.active !== undefined && { active: dto.active }),
      });
      await manager.save(TierConfig, after);

      // immediate 시 user_coin_balances 의 monthly_coin_limit diff 반영
      let affectedUsers = 0;
      if (dto.applyMode === 'immediate' && dto.monthlyCoinLimit !== undefined) {
        const diff = dto.monthlyCoinLimit - Number(before.monthlyCoinLimit);
        if (diff !== 0) {
          const result = await manager.query<{ count: string }[]>(
            `UPDATE user_coin_balances
             SET balance = balance + $1
             WHERE tier = $2
             RETURNING user_id`,
            [diff, tier],
          );
          affectedUsers = returningRows(result).length; // UPDATE...RETURNING 튜플 정규화
        }
      } else {
        affectedUsers = await manager.count(UserCoinBalance, {
          where: { tier },
        });
      }

      // audit
      await this.auditService.log(
        adminId,
        'update_tier_config',
        'tier_config',
        tier,
        {
          before: {
            monthlyCoinLimit: Number(before.monthlyCoinLimit),
            inputTokenCapPerCall: before.inputTokenCapPerCall,
            defaultCooldownSeconds: before.defaultCooldownSeconds,
            noteSummaryCooldownMinutes: before.noteSummaryCooldownMinutes,
            priceKrw: before.priceKrw,
            active: before.active,
          },
          after: {
            monthlyCoinLimit: Number(after.monthlyCoinLimit),
            inputTokenCapPerCall: after.inputTokenCapPerCall,
            defaultCooldownSeconds: after.defaultCooldownSeconds,
            noteSummaryCooldownMinutes: after.noteSummaryCooldownMinutes,
            priceKrw: after.priceKrw,
            active: after.active,
          },
          applyMode: dto.applyMode,
          affectedUsers,
        },
        manager,
        ctx,
      );

      return { updated: after, affectedUsers };
    });
  }
}
