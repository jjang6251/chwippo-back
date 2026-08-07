import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CostGuardService } from '../ai/cost-guard.service';
import { AdminAuditService } from './admin-audit.service';
import { AlertHistory } from './entities/alert-history.entity';
import { AlertThresholds } from './entities/alert-thresholds.entity';

/**
 * 감사 로그용 임계치 스냅샷 — **전 필드**를 담는다.
 *
 * 🔴 예전엔 4개(`dailyCostThresholdUsd`·`hourlyErrorRateThreshold`·
 * `vsYesterdayIncreaseThreshold`·`enabled`)만 기록했다. 그래서 17개 중 13개는
 * **바뀌어도 흔적이 남지 않았다** — 2026-08-06 에 `perFeatureDailyCostUsd` 가 0 이 되어
 * 전 기능 AI 가 죽었는데, 감사 로그의 before/after 가 완전히 동일해서
 * 누가 언제 무엇을 바꿨는지 끝내 알 수 없었다.
 *
 * 필드를 나열하지 않고 **덜어내는 방식**으로 만든 이유는, 새 임계치가 추가될 때
 * 여기를 고치는 걸 잊어도 자동으로 포함되게 하기 위해서다 (같은 사고 재발 방지).
 */
function snapshotThresholds(row: AlertThresholds): Record<string, unknown> {
  const snapshot: Record<string, unknown> = { ...row };
  // 변경 대상이 아닌 식별자·감사 메타는 제외한다.
  // 🔴 `updatedByUser` 는 User 엔티티다 — 담기면 닉네임·이메일 같은 PII 가 JSON 으로
  //   박힌다. 관계를 로드하지 않는 지금도 방어적으로 지운다.
  for (const key of ['id', 'updatedBy', 'updatedAt', 'updatedByUser']) {
    delete snapshot[key];
  }
  return snapshot;
}

export interface UpdateAlertThresholdsDto {
  dailyCostThresholdUsd?: number;
  hourlyErrorRateThreshold?: number;
  vsYesterdayIncreaseThreshold?: number;
  enabled?: boolean;
  adminGrantPerHourAlert?: number;
  adminGrantSingleAlert?: number;
  inquirySlaHours?: number;
  abuserSuspectDailyCalls?: number;
  freeUserSignupSpikePct?: number;
  costOutlierStddev?: number;
  // AI cost guard
  perUserDailyCostUsd?: number;
  perFeatureDailyCostUsd?: number;
  // G-8 런타임 이상 알람 (2026-08-03) — 둘 다 **정상이면 0 이어야 하는** 지표
  outputTruncationCount1h?: number;
  chargedFailureCount1h?: number;
  // AI 제공사 장애 알림
  aiOutageAlertCount10m?: number;
  aiOutageAlertCooldownMin?: number;
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
    // cost hardening 🟡3 — 임계치 수정 시 CostGuard 5분 캐시 즉시 무효화
    private readonly costGuard: CostGuardService,
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
    const before = snapshotThresholds(row);
    if (dto.dailyCostThresholdUsd !== undefined)
      row.dailyCostThresholdUsd = dto.dailyCostThresholdUsd;
    if (dto.hourlyErrorRateThreshold !== undefined)
      row.hourlyErrorRateThreshold = dto.hourlyErrorRateThreshold;
    if (dto.vsYesterdayIncreaseThreshold !== undefined)
      row.vsYesterdayIncreaseThreshold = dto.vsYesterdayIncreaseThreshold;
    if (dto.enabled !== undefined) row.enabled = dto.enabled;
    if (dto.adminGrantPerHourAlert !== undefined)
      row.adminGrantPerHourAlert = dto.adminGrantPerHourAlert;
    if (dto.adminGrantSingleAlert !== undefined)
      row.adminGrantSingleAlert = dto.adminGrantSingleAlert;
    if (dto.inquirySlaHours !== undefined)
      row.inquirySlaHours = dto.inquirySlaHours;
    if (dto.abuserSuspectDailyCalls !== undefined)
      row.abuserSuspectDailyCalls = dto.abuserSuspectDailyCalls;
    if (dto.freeUserSignupSpikePct !== undefined)
      row.freeUserSignupSpikePct = dto.freeUserSignupSpikePct;
    if (dto.costOutlierStddev !== undefined)
      row.costOutlierStddev = dto.costOutlierStddev;
    if (dto.outputTruncationCount1h !== undefined)
      row.outputTruncationCount1h = dto.outputTruncationCount1h;
    if (dto.chargedFailureCount1h !== undefined)
      row.chargedFailureCount1h = dto.chargedFailureCount1h;
    // AI cost guard
    if (dto.perUserDailyCostUsd !== undefined)
      row.perUserDailyCostUsd = dto.perUserDailyCostUsd;
    if (dto.perFeatureDailyCostUsd !== undefined)
      row.perFeatureDailyCostUsd = dto.perFeatureDailyCostUsd;
    if (dto.aiOutageAlertCount10m !== undefined)
      row.aiOutageAlertCount10m = dto.aiOutageAlertCount10m;
    if (dto.aiOutageAlertCooldownMin !== undefined)
      row.aiOutageAlertCooldownMin = dto.aiOutageAlertCooldownMin;
    row.updatedBy = adminUserId;
    const saved = await this.repo.save(row);
    // 🟡3 — 저장 즉시 CostGuard 캐시 무효화 (기존엔 최대 5분 stale)
    this.costGuard.invalidate();

    await this.audit.log(
      adminUserId,
      'update_alert_thresholds',
      'alert_thresholds',
      '1',
      { before, after: snapshotThresholds(saved) },
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
