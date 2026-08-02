import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { LlmFeature, LlmProviderName } from './llm-call-log.entity';

/**
 * G-1 (2026-08-02) — feature 별 LLM 모델 설정. **admin 이 재배포 없이 바꾼다.**
 *
 * **왜 필요한가** — 모델이 env 2개(`ANTHROPIC_MODEL_LIGHT`·`OPENAI_MODEL_LIGHT`)로만
 * 정해져서, 자소서 3종과 면접이 같은 값을 공유했다. "자소서만 상위 모델" 이 물리적으로
 * 불가능했고, 바꾸려면 재배포가 필요해 롤백 경로도 없었다.
 * (쿼터·코인·티어는 이미 admin 에서 즉시 바뀌는데 모델만 그러지 못하는 비일관도 있었다)
 *
 * **왜 `feature_coin_meta` 확장이 아니라 새 테이블인가** — coin_meta 는 **과금하는
 * feature 8행**만 갖는데 모델 설정은 **14 feature 전부** 필요하다. 관심사도 다르다
 * (과금 정책 ≠ 모델 정책).
 *
 * **"설정 없음" 은 행 부재로 표현한다** — nullable 컬럼을 두지 않는다.
 * 행이 없으면 `ModelConfigService` 가 env → 코드 기본값 순으로 폴백한다.
 */
@Entity('feature_model_config')
export class FeatureModelConfig {
  /** `LlmFeature` enum 값 (`feature_coin_meta` 와 동일 방식) */
  @PrimaryColumn({ type: 'varchar', length: 50 })
  feature: LlmFeature;

  @Column({ type: 'varchar', length: 20 })
  provider: Exclude<LlmProviderName, 'mock'>;

  /** `MODEL_REGISTRY` 키. 화이트리스트 밖 값은 admin service 가 저장 시 차단한다 */
  @Column({ type: 'varchar', length: 60 })
  model: string;

  /**
   * 마지막으로 바꾼 admin.
   * **ON DELETE SET NULL** — 관리자가 탈퇴해도 모델 설정 자체는 남아야 한다
   * (설정이 사라지면 그 feature 가 통째로 폴백돼 동작이 조용히 바뀐다).
   */
  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
