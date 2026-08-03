import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/user.entity';

/**
 * **지금 호출할 수 있는** feature. `LlmService.call` 과 `FEATURE_MATRIX` 가 이 타입을 쓴다.
 *
 * 🔴 퇴역 feature 와 갈라둔 이유 (2026-08-03) — 두 개는 성격이 다른데 하나로 묶여 있었다:
 *   - **감사 이력**: 과거 `llm_call_logs` 행을 읽으려면 옛 값도 타입에 있어야 한다
 *   - **현재 설정**: "지금 어떤 모델로 부를까" 는 안 부르는 기능이 있을 이유가 없다
 *
 * 구분이 없어서 `FEATURE_MATRIX` 에 **한 번도 호출된 적 없는 6개**가 1년 넘게 남아 있었고,
 * G-1 admin 매트릭스가 화면이 되면서 관리자에게 14줄 중 6줄이 죽은 항목으로 노출됐다.
 * (`coverletter` 와 `coverletter_draft_v2` 가 나란히 떠서 어느 쪽이 진짜인지 알 수 없었다)
 */
export type ActiveLlmFeature =
  | 'note_summary'
  | 'coverletter_draft_v2'
  | 'coverletter_feedback'
  | 'coverletter_recommend'
  | 'coverletter_chat'
  | 'interview_prep_session'
  | 'interview_prep_followup'
  | 'jobposting_parse';

/**
 * 퇴역 feature — **과거 `llm_call_logs` 행에 문자열로 남아 있어 타입에서 못 지운다.**
 * 새 호출은 불가능하다 (`ActiveLlmFeature` 가 아니므로 `LlmService.call` 이 컴파일 거부).
 *
 * | 값 | 사유 |
 * |---|---|
 * | `coverletter` | 자소서 v1 → `coverletter_draft_v2` 로 대체 (F6 PR 1, 2026-05-26) |
 * | `interview` | 면접 v1 → `interview_prep_session` 으로 대체 |
 * | `interview_followup` | 꼬리질문 v1 → `interview_prep_followup` 으로 대체 |
 * | `score` · `analysis` | F5 때 타입·설정만 선언하고 **구현한 적 없음** (호출부가 커밋 이력에 부재) |
 * | `auto_tag` | `auto-tagger.ts` 가 **규칙 기반**으로 구현돼 LLM 불필요 |
 * | `company_research` | 2026-07-09 퇴역 — 유저 트리거 조사 제거 (pre-seed 공급 전환, ADR-040) |
 */
export type RetiredLlmFeature =
  | 'coverletter'
  | 'interview'
  | 'interview_followup'
  | 'score'
  | 'analysis'
  | 'auto_tag'
  | 'company_research';

/** 저장·조회용 전체 집합 (감사 이력 포함). **호출에는 `ActiveLlmFeature` 를 쓴다** */
export type LlmFeature = ActiveLlmFeature | RetiredLlmFeature;

/** F6 PR 2 Phase 5.6 — 'mock' 은 NODE_ENV='development' + API key 미설정 시 LlmService 의 mock 분기 (UI 흐름 테스트 전용). production 절대 X */
export type LlmProviderName = 'openai' | 'anthropic' | 'mock';

export type LlmCallStatus =
  | 'ok'
  | 'error'
  | 'blocked_moderation'
  | 'blocked_quota'
  | 'blocked_consent' // ai_consent_at IS NULL (개인정보보호법 26조 — 제3자 처리위탁 동의)
  | 'blocked_input_cap' // prompt 토큰이 feature 별 maxInputTokens 초과
  | 'blocked_cost_quota' // AI cost guard — per-user/per-feature daily USD cost cap 초과 (코인 외 추가 가드)
  | 'retry_parsing'; // callJson schema 위반 → 1회 재시도 (별도 audit row, quota 카운트 포함)

@Entity('llm_call_logs')
@Index('idx_llm_call_logs_user_feature', ['userId', 'feature', 'createdAt'])
@Index('idx_llm_call_logs_created', ['createdAt'])
@Index('idx_llm_call_logs_provider', ['provider', 'createdAt'])
export class LlmCallLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', length: 40 })
  feature: LlmFeature;

  /** PR 0 — multi-provider 식별 (OpenAI/Anthropic). 기존 row 는 마이그레이션에서 'openai' backfill */
  @Column({ type: 'varchar', length: 20 })
  provider: LlmProviderName;

  @Column({ type: 'varchar', length: 40 })
  model: string;

  @Column({ name: 'prompt_tokens', type: 'int', default: 0 })
  promptTokens: number;

  @Column({ name: 'completion_tokens', type: 'int', default: 0 })
  completionTokens: number;

  /** PR_B1 — Anthropic prompt cache write 토큰 ($1.25/M, input × 1.25) */
  @Column({ name: 'cache_creation_tokens', type: 'int', default: 0 })
  cacheCreationTokens: number;

  /** PR_B1 — Anthropic prompt cache hit 토큰 ($0.10/M, input × 0.10 — 90% 할인) */
  @Column({ name: 'cache_read_tokens', type: 'int', default: 0 })
  cacheReadTokens: number;

  /** PR_B1 — Anthropic web_search tool 사용 횟수 ($10/1000 = $0.01/search) */
  @Column({ name: 'web_search_count', type: 'int', default: 0 })
  webSearchCount: number;

  /** PR_B1 — 차감된 코인 (0 = 차감 X — preBlocked·error·charges_coins=false 등) */
  @Column({
    name: 'coin_cost',
    type: 'numeric',
    precision: 6,
    scale: 2,
    default: 0,
  })
  coinCost: string;

  /** PR_B1 — cost USD 분해 (`{input, output, cache_creation, cache_read, web_search}` 5 키) */
  @Column({ name: 'cost_breakdown', type: 'jsonb', nullable: true })
  costBreakdown: Record<string, number> | null;

  @Column({
    name: 'cost_usd',
    type: 'numeric',
    precision: 10,
    scale: 6,
    default: 0,
  })
  costUsd: string;

  @Column({ name: 'latency_ms', type: 'int', default: 0 })
  latencyMs: number;

  @Column({ type: 'varchar', length: 20 })
  status: LlmCallStatus;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({
    name: 'resource_type',
    type: 'varchar',
    length: 40,
    nullable: true,
  })
  resourceType: string | null;

  @Column({ name: 'resource_id', type: 'uuid', nullable: true })
  resourceId: string | null;

  /** PR 0 — PII 스크럽 후 prompt 의 SHA256 (사용자 데이터 권리 조회·중복 호출 추적용) */
  @Column({ name: 'prompt_hash', type: 'varchar', length: 64, nullable: true })
  promptHash: string | null;

  /** PR 0 — PII 스크럽 후 prompt 앞 200자 (디버깅·CS·`GET /me/ai-usage` 표시). 30일 후 익명화 cron */
  @Column({
    name: 'prompt_excerpt',
    type: 'varchar',
    length: 200,
    nullable: true,
  })
  promptExcerpt: string | null;

  /** PR 0 — 응답 본문에 PII 패턴 검출 시 true (model hallucination 감시 metric) */
  @Column({ name: 'output_redacted', type: 'boolean', default: false })
  outputRedacted: boolean;

  /** PR 0 — callJson 시도 횟수 (1=정상, 2=schema 재시도. SDK transport retry 는 0 강제) */
  @Column({ type: 'int', default: 1 })
  attempts: number;

  /**
   * D0 (2026-08-01 자소서 점검 크래시) — provider 가 응답을 왜 끝냈는지.
   *
   * `'length'` = **출력 토큰 한도에 걸려 잘림**. 지금까지 provider 가 계산만 하고 버려서
   * 잘림이 로그에 전혀 남지 않았고, 그래서 이번 사고를 사용자 신고 전까지 아무도 몰랐다.
   *
   * NULL = 이 컬럼 도입 이전 row, 또는 blocked_* 처럼 provider 미호출 경로.
   * 인덱스는 두지 않는다 — 집계는 기존 `(feature, created_at)` 인덱스로 충분.
   */
  @Column({
    name: 'finish_reason',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  finishReason: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
