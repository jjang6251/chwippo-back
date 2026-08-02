import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { FeatureModelConfig } from '../ai/entities/feature-model-config.entity';
import type { LlmFeature } from '../ai/entities/llm-call-log.entity';
import { getModelConfig } from '../ai/model-config';
import {
  MODEL_REGISTRY,
  canonicalModelId,
  effectivePricing,
  getModelSpec,
  type ModelSpec,
} from '../ai/model-registry';
import { todayKst } from '../common/datetime';
import { AdminAuditService } from './admin-audit.service';
import { UpdateFeatureModelDto } from './dto/update-feature-model.dto';

/** admin 화면 한 줄 — 현재 설정 + 판단 근거 */
export interface FeatureModelRow {
  feature: LlmFeature;
  provider: string;
  model: string;
  label: string;
  /** 현재 모델의 원가가 코인 기준(anchor $1/M) 대비 몇 배인가 — 비교·경고용 */
  costMultiplier: number;
  /** 실단가 (USD per 1M tokens). 추정이 아니라 우리가 실제로 내는 값 — 청구서와 대조된다 */
  inputUsd: number;
  outputUsd: number;
  maxOutputTokens: number;
  requiresStreaming: boolean;
  updatedBy: string | null;
  updatedAt: Date | null;
  /** 이 feature 로 **바꿀 수 있는** 모델만. 못 바꾸는 건 이유와 함께 준다 */
  selectable: Array<{
    id: string;
    label: string;
    provider: string;
    costMultiplier: number;
    inputUsd: number;
    outputUsd: number;
    /** null 이면 선택 가능, 아니면 불가 사유 */
    blockedReason: string | null;
  }>;
}

/**
 * G-1 (2026-08-02) — feature 별 LLM 모델을 admin 이 재배포 없이 바꾼다.
 *
 * **저장 시 3종을 검증한다.** 재배포라는 관문이 사라지므로, 잘못 누르면 즉시 반영된다.
 *   ① 화이트리스트 — 레지스트리 밖 모델 (DTO 에서 1차, 여기서 2차)
 *   ② 출력 한도 — feature cap 이 모델 상한을 넘으면 호출 시 API 400
 *   ③ 스트리밍 — `requiresStreaming` feature 를 미지원 모델로 바꾸면 기능이 죽는다
 *
 * **스키마 호환(strict)은 여기서 검사하지 않는다.** 현재 5개 스키마가 전부 strict 규격을
 * 만족하고 그 사실을 `model-registry.spec` 이 **빌드 시점에** 강제한다. 런타임 검증을
 * 더하려면 admin service 가 5개 caller service 의 스키마를 import 해야 해서 결합만 늘고
 * 얻는 게 없다 — 빌드에서 막히는 걸 런타임에 또 막을 이유는 없다.
 */
@Injectable()
export class FeatureModelAdminService {
  constructor(
    @InjectRepository(FeatureModelConfig)
    private readonly repo: Repository<FeatureModelConfig>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly auditService: AdminAuditService,
  ) {}

  /** 오늘 적용되는 실단가 (유효기간 만료 반영) */
  private pricing(spec: ModelSpec) {
    const p = effectivePricing(spec, todayKst());
    return {
      inputUsd: p.input,
      outputUsd: p.output,
      // anchor($1/M) 대비 배수 — 절대값보다 "몇 배 오르나" 가 판단에 직접적이다
      costMultiplier: Number((p.input / 1.0).toFixed(2)),
    };
  }

  /**
   * 이 feature 에서 그 모델을 고를 수 있는가. 못 고르면 **이유를 문자열로** 돌려준다.
   * 화면에 "왜 회색인지" 를 그대로 보여주기 위해서다.
   */
  private blockedReason(feature: LlmFeature, spec: ModelSpec): string | null {
    const matrix = getModelConfig(feature, this.config);

    if (matrix.maxOutputTokens > spec.maxOutputTokens) {
      return `출력 한도 초과 — 이 기능은 ${matrix.maxOutputTokens.toLocaleString()} 토큰이 필요한데 이 모델의 상한은 ${spec.maxOutputTokens.toLocaleString()} 입니다`;
    }
    if (matrix.requiresStreaming && !spec.supportsStreaming) {
      return '이 기능은 실시간 응답(스트리밍)이 필요한데 이 모델은 지원하지 않습니다';
    }
    return null;
  }

  async listAll(): Promise<FeatureModelRow[]> {
    const rows = await this.repo.find({ order: { feature: 'ASC' } });

    return rows.map((row) => {
      const spec = getModelSpec(row.model);
      const matrix = getModelConfig(row.feature, this.config);

      return {
        feature: row.feature,
        provider: row.provider,
        model: row.model,
        label: spec?.label ?? `${row.model} (미등록)`,
        ...(spec
          ? this.pricing(spec)
          : { costMultiplier: 0, inputUsd: 0, outputUsd: 0 }),
        maxOutputTokens: matrix.maxOutputTokens,
        requiresStreaming: matrix.requiresStreaming === true,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt ?? null,
        selectable: Object.entries(MODEL_REGISTRY).map(([id, s]) => ({
          id,
          label: s.label,
          provider: s.provider,
          ...this.pricing(s),
          blockedReason: this.blockedReason(row.feature, s),
        })),
      };
    });
  }

  async updateModel(
    adminId: string,
    feature: LlmFeature,
    dto: UpdateFeatureModelDto,
    ctx?: { ip?: string | null; userAgent?: string | null },
  ): Promise<FeatureModelConfig> {
    // ① 화이트리스트 (DTO 에서 이미 막히지만, 서비스 단독 호출·향후 경로 대비)
    const canonical = canonicalModelId(dto.model);
    const spec = canonical ? getModelSpec(canonical) : null;
    if (!canonical || !spec) {
      throw new BadRequestException(
        `등록되지 않은 모델입니다: ${dto.model}. MODEL_REGISTRY 에 먼저 추가하세요.`,
      );
    }

    // ②③ feature 별 제약
    const blocked = this.blockedReason(feature, spec);
    if (blocked) throw new BadRequestException(blocked);

    return await this.dataSource.transaction(async (manager) => {
      const before = await manager.findOne(FeatureModelConfig, {
        where: { feature },
        lock: { mode: 'pessimistic_write' },
      });
      if (!before) {
        throw new BadRequestException(
          `feature_model_config 행이 없습니다: ${feature}`,
        );
      }

      const after = manager.create(FeatureModelConfig, {
        ...before,
        // provider 는 **모델에서 파생**한다 — 클라이언트가 보내지 않으므로 불일치가 없다
        provider: spec.provider,
        model: canonical,
        updatedBy: adminId,
      });
      await manager.save(FeatureModelConfig, after);

      await this.auditService.log(
        adminId,
        'update_feature_model',
        'feature_model_config',
        feature,
        {
          before: { provider: before.provider, model: before.model },
          after: { provider: after.provider, model: after.model },
        },
        manager,
        ctx,
      );

      return after;
    });
  }
}
