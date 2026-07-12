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

export type LlmFeature =
  // 기존 (F5)
  | 'note_summary'
  | 'coverletter'
  | 'interview'
  | 'interview_followup'
  | 'score'
  | 'analysis'
  | 'auto_tag'
  // PR 0 신규 — F6 PR 1·2 에서 활용
  | 'coverletter_draft_v2'
  | 'coverletter_feedback'
  | 'coverletter_recommend'
  | 'interview_prep_session'
  | 'interview_prep_followup'
  // 'company_research' 는 2026-07-09 퇴역 — 유저 트리거 조사 제거 (pre-seed 공급 전환).
  //   과거 llm_call_logs 행에는 문자열로 남아 있음 (audit 보존).
  // F1 자소서 풀페이지 Phase D — AI 채팅 (multi-turn, structured output, suggestedUpdates 적용)
  | 'coverletter_chat'
  // 공고 요건 파싱 (jobposting-parse) — 붙여넣은 공고 텍스트를 6필드 구조화 (light·strict JSON)
  | 'jobposting_parse';

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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
