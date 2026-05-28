import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminAuditService } from './admin-audit.service';
import { AlertHistory } from './entities/alert-history.entity';
import { AlertThresholds } from './entities/alert-thresholds.entity';

export interface UpdateAlertThresholdsDto {
  dailyCostThresholdUsd?: number;
  hourlyErrorRateThreshold?: number;
  vsYesterdayIncreaseThreshold?: number;
  enabled?: boolean;
}

/**
 * F6 PR 2 Phase 5.4 — 임계치 단일 row 조회/수정 + 최근 24h history.
 */
@Injectable()
export class AlertThresholdsService {
  constructor(
    @InjectRepository(AlertThresholds)
    private readonly repo: Repository<AlertThresholds>,
    @InjectRepository(AlertHistory)
    private readonly historyRepo: Repository<AlertHistory>,
    private readonly audit: AdminAuditService,
  ) {}

  /** 단일 row — 마이그레이션이 id=1 row 보장. 누락 시 NotFound (자동 생성 X — 의도적 데이터 무결성) */
  async get(): Promise<AlertThresholds> {
    const row = await this.repo.findOne({ where: { id: 1 } });
    if (!row) {
      throw new NotFoundException(
        '알람 임계치 설정이 초기화되지 않았어요. 마이그레이션을 확인해주세요.',
      );
    }
    return row;
  }

  async update(
    adminUserId: string,
    dto: UpdateAlertThresholdsDto,
  ): Promise<AlertThresholds> {
    const row = await this.get();
    const before = {
      dailyCostThresholdUsd: row.dailyCostThresholdUsd,
      hourlyErrorRateThreshold: row.hourlyErrorRateThreshold,
      vsYesterdayIncreaseThreshold: row.vsYesterdayIncreaseThreshold,
      enabled: row.enabled,
    };
    if (dto.dailyCostThresholdUsd !== undefined)
      row.dailyCostThresholdUsd = dto.dailyCostThresholdUsd;
    if (dto.hourlyErrorRateThreshold !== undefined)
      row.hourlyErrorRateThreshold = dto.hourlyErrorRateThreshold;
    if (dto.vsYesterdayIncreaseThreshold !== undefined)
      row.vsYesterdayIncreaseThreshold = dto.vsYesterdayIncreaseThreshold;
    if (dto.enabled !== undefined) row.enabled = dto.enabled;
    row.updatedBy = adminUserId;
    const saved = await this.repo.save(row);

    await this.audit.log(
      adminUserId,
      'update_alert_thresholds',
      'alert_thresholds',
      '1',
      {
        before,
        after: {
          dailyCostThresholdUsd: saved.dailyCostThresholdUsd,
          hourlyErrorRateThreshold: saved.hourlyErrorRateThreshold,
          vsYesterdayIncreaseThreshold: saved.vsYesterdayIncreaseThreshold,
          enabled: saved.enabled,
        },
      },
    );
    return saved;
  }

  /** 최근 24h alert history — admin UI 의 "최근 알람" 테이블 */
  async recentHistory(): Promise<AlertHistory[]> {
    return this.historyRepo
      .createQueryBuilder('h')
      .where("h.created_at > now() - INTERVAL '24 hours'")
      .orderBy('h.created_at', 'DESC')
      .limit(50)
      .getMany();
  }
}
