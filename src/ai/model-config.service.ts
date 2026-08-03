import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FeatureModelConfig } from './entities/feature-model-config.entity';
import type { LlmFeature } from './entities/llm-call-log.entity';
import { getModelConfig, type ModelConfig } from './model-config';

export type ResolvedModelConfig = ModelConfig & { model: string };

/**
 * G-1 (2026-08-02) — feature 별 모델 해석. **DB → env → 코드 기본값** 3단.
 *
 * **왜 3단인가**
 * - DB(`feature_model_config`) — admin 이 재배포 없이 바꾸는 값. 최우선
 * - env — 기존 운영 방식. DB 행이 없을 때(마이그레이션 직후·롤백 상황) 그대로 동작
 * - 코드 기본값 — 최후. 신규 feature 가 아직 어디에도 없을 때
 *
 * 각 단이 **아래 단을 무효화하지 않는다.** DB 행을 지우면 자동으로 env 로 되돌아가므로
 * 롤백이 "행 삭제" 만으로 끝난다.
 *
 * **왜 캐시하지 않나** (CEO Q3=A)
 * 인메모리 캐시를 두면 레플리카가 2대 이상일 때 admin 이 A 에서 바꿔도 B 는 옛 값을 쓴다.
 * 그 불일치는 **운영에서만 드러나서** mock·CI 로는 원리적으로 못 잡는다. 반면 조회 비용은
 * PK 단건이고, `CoinService` 가 이미 호출당 3번 읽고 있어 관행상으로도 새로운 부담이 아니다.
 * (LLM 호출 자체가 초 단위라 sub-ms 조회는 무시할 수 있다)
 *
 * **provider·model 만 DB 에서 온다.** 토큰 한도·temperature 는 `FEATURE_MATRIX` 가 계속
 * 소유한다 — admin 이 건드릴 범위를 최소로 두고, cap 은 `model-config.spec` 이 박제 중이다.
 */
@Injectable()
export class ModelConfigService {
  private readonly logger = new Logger(ModelConfigService.name);

  constructor(
    @InjectRepository(FeatureModelConfig)
    private readonly repo: Repository<FeatureModelConfig>,
    private readonly config: ConfigService,
  ) {}

  async resolve(feature: LlmFeature): Promise<ResolvedModelConfig> {
    // env → 코드 기본값 (기존 로직 그대로) + 토큰 한도·temperature
    const base = getModelConfig(feature, this.config);

    let row: FeatureModelConfig | null = null;
    try {
      row = await this.repo.findOne({ where: { feature } });
    } catch (err) {
      // 🔴 DB 조회 실패로 LLM 호출 전체가 죽으면 안 된다 — env 로 계속 진행한다.
      //   조용히 넘어가진 않는다 (설정이 반영 안 된 채 도는 상태이므로).
      this.logger.error(
        `feature_model_config 조회 실패 (feature=${feature}) — env 설정으로 진행합니다: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return base;
    }

    if (!row) return base;

    return { ...base, provider: row.provider, model: row.model };
  }
}
