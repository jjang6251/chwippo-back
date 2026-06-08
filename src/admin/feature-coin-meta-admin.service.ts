import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { FeatureCoinMeta } from '../ai/entities/feature-coin-meta.entity';
import { AdminAuditService } from './admin-audit.service';
import { UpdateFeatureCoinMetaDto } from './dto/update-feature-coin-meta.dto';

/**
 * PR_B2 Phase 3 — feature_coin_meta 매트릭스 수정.
 *
 * 즉시 적용 (다음 호출부터) — confirm UI (frontend) 강제. audit before/after.
 *
 * chargesCoins / fixedCoinCost / avgCoinCost / description.
 */
@Injectable()
export class FeatureCoinMetaAdminService {
  constructor(
    @InjectRepository(FeatureCoinMeta)
    private readonly repo: Repository<FeatureCoinMeta>,
    private readonly dataSource: DataSource,
    private readonly auditService: AdminAuditService,
  ) {}

  async listAll(): Promise<FeatureCoinMeta[]> {
    return await this.repo.find({ order: { feature: 'ASC' } });
  }

  async getOne(feature: string): Promise<FeatureCoinMeta> {
    const row = await this.repo.findOne({ where: { feature } as never });
    if (!row) {
      throw new NotFoundException(`feature_coin_meta 가 없습니다: ${feature}`);
    }
    return row;
  }

  /**
   * chargesCoins=true 면 fixedCoinCost 또는 avgCoinCost 중 하나는 명시 필요 (semantic 검증).
   */
  private validateSemantic(
    after: FeatureCoinMeta,
    dto: UpdateFeatureCoinMetaDto,
  ): void {
    if (after.chargesCoins) {
      const fixedMissing = after.fixedCoinCost === null;
      const avgMissing =
        after.avgCoinCost === null || Number(after.avgCoinCost) === 0;
      if (fixedMissing && avgMissing) {
        throw new BadRequestException(
          'chargesCoins=true 일 때 fixedCoinCost 또는 avgCoinCost 중 하나는 명시해야 합니다.',
        );
      }
    }
    void dto;
  }

  async updateFeatureCoinMeta(
    adminId: string,
    feature: string,
    dto: UpdateFeatureCoinMetaDto,
    ctx?: { ip?: string | null; userAgent?: string | null },
  ): Promise<FeatureCoinMeta> {
    return await this.dataSource.transaction(async (manager) => {
      const before = await manager.findOne(FeatureCoinMeta, {
        where: { feature } as never,
        lock: { mode: 'pessimistic_write' },
      });
      if (!before) {
        throw new NotFoundException(
          `feature_coin_meta 가 없습니다: ${feature}`,
        );
      }

      const after = manager.create(FeatureCoinMeta, {
        ...before,
        ...(dto.chargesCoins !== undefined && {
          chargesCoins: dto.chargesCoins,
        }),
        ...(dto.fixedCoinCost !== undefined && {
          fixedCoinCost: dto.fixedCoinCost,
        }),
        ...(dto.avgCoinCost !== undefined && {
          avgCoinCost: String(dto.avgCoinCost.toFixed(1)),
        }),
        ...(dto.description !== undefined && {
          description: dto.description,
        }),
      });

      this.validateSemantic(after, dto);

      await manager.save(FeatureCoinMeta, after);

      await this.auditService.log(
        adminId,
        'update_feature_coin_meta',
        'feature_coin_meta',
        feature,
        {
          before: {
            chargesCoins: before.chargesCoins,
            fixedCoinCost: before.fixedCoinCost,
            avgCoinCost: Number(before.avgCoinCost),
            description: before.description,
          },
          after: {
            chargesCoins: after.chargesCoins,
            fixedCoinCost: after.fixedCoinCost,
            avgCoinCost: Number(after.avgCoinCost),
            description: after.description,
          },
        },
        manager,
        ctx,
      );

      return after;
    });
  }
}
