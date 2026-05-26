import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminAuditService } from '../admin/admin-audit.service';
import {
  FeatureQuotaConfig,
  type QuotaTier,
} from './entities/feature-quota-config.entity';
import type { LlmFeature } from './entities/llm-call-log.entity';

const VALID_FEATURES: LlmFeature[] = [
  'note_summary',
  'auto_tag',
  'score',
  'analysis',
  'coverletter',
  'coverletter_draft_v2',
  'coverletter_feedback',
  'coverletter_recommend',
  'interview',
  'interview_followup',
  'interview_prep_session',
  'interview_prep_followup',
];

const VALID_TIERS: QuotaTier[] = ['free', 'pro', 'enterprise'];

/**
 * F6 PR 2 Phase 1 — admin 의 feature × tier 매트릭스 관리.
 *
 * **변경 즉시 효과**: QuotaCheckService 가 캐시 없이 매 호출 DB 조회 → 본 service 의 update 가 즉시 반영.
 * **audit 의무** — admin 의 모든 변경은 `admin_audit_logs.action='update_ai_quota'` 로 기록.
 */
@Injectable()
export class AdminFeatureQuotasService {
  constructor(
    @InjectRepository(FeatureQuotaConfig)
    private readonly repo: Repository<FeatureQuotaConfig>,
    @Inject(forwardRef(() => AdminAuditService))
    private readonly auditService: AdminAuditService,
  ) {}

  async listAll(): Promise<FeatureQuotaConfig[]> {
    return this.repo.find({
      order: { feature: 'ASC', tier: 'ASC' },
    });
  }

  async getOne(feature: string, tier: string): Promise<FeatureQuotaConfig> {
    this.assertValid(feature, tier);
    const row = await this.repo.findOne({
      where: { feature: feature as LlmFeature, tier: tier as QuotaTier },
    });
    if (!row) {
      throw new NotFoundException(
        `feature_quota_configs row 없음 (feature=${feature}, tier=${tier})`,
      );
    }
    return row;
  }

  async update(
    adminId: string,
    feature: string,
    tier: string,
    patch: {
      dayLimit?: number;
      monthLimit?: number;
      cooldownSeconds?: number;
      enabled?: boolean;
    },
  ): Promise<FeatureQuotaConfig> {
    this.assertValid(feature, tier);
    const row = await this.repo.findOne({
      where: { feature: feature as LlmFeature, tier: tier as QuotaTier },
    });
    if (!row) {
      throw new NotFoundException(
        `feature_quota_configs row 없음 (feature=${feature}, tier=${tier})`,
      );
    }

    const before = {
      dayLimit: row.dayLimit,
      monthLimit: row.monthLimit,
      cooldownSeconds: row.cooldownSeconds,
      enabled: row.enabled,
    };
    let changed = false;
    if (patch.dayLimit !== undefined && patch.dayLimit !== row.dayLimit) {
      row.dayLimit = patch.dayLimit;
      changed = true;
    }
    if (
      patch.monthLimit !== undefined &&
      patch.monthLimit !== row.monthLimit
    ) {
      row.monthLimit = patch.monthLimit;
      changed = true;
    }
    if (
      patch.cooldownSeconds !== undefined &&
      patch.cooldownSeconds !== row.cooldownSeconds
    ) {
      row.cooldownSeconds = patch.cooldownSeconds;
      changed = true;
    }
    if (patch.enabled !== undefined && patch.enabled !== row.enabled) {
      row.enabled = patch.enabled;
      changed = true;
    }

    if (!changed) return row;

    if (row.dayLimit > row.monthLimit) {
      throw new BadRequestException(
        'dayLimit 는 monthLimit 보다 클 수 없습니다.',
      );
    }

    row.updatedBy = adminId;
    row.updatedAt = new Date();
    const saved = await this.repo.save(row);

    await this.auditService.log(adminId, 'update_ai_quota', 'feature_quota', `${feature}:${tier}`, {
      feature,
      tier,
      before,
      after: {
        dayLimit: saved.dayLimit,
        monthLimit: saved.monthLimit,
        cooldownSeconds: saved.cooldownSeconds,
        enabled: saved.enabled,
      },
    });

    return saved;
  }

  private assertValid(feature: string, tier: string): void {
    if (!VALID_FEATURES.includes(feature as LlmFeature)) {
      throw new BadRequestException(`feature '${feature}' invalid`);
    }
    if (!VALID_TIERS.includes(tier as QuotaTier)) {
      throw new BadRequestException(`tier '${tier}' invalid`);
    }
  }
}
