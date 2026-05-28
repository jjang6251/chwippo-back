import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * F6 PR 2 Phase 4 단계 B — 회사 조사 캐시 (공유, 90일 TTL).
 *
 * **shape of `ai_research` JSONB** (8 항목):
 * ```
 * {
 *   businessSummary: string,         // 사업 영역 한 줄
 *   coreValues: string,              // 인재상·핵심가치
 *   visionMission: string,           // 회사 비전·미션
 *   recentTrends: string,            // 최근 사업 동향·신사업
 *   financials: string,              // 재무·매출 트렌드 3년
 *   competitors: string,             // 경쟁사·시장 포지셔닝
 *   jobInsights: string,             // 직무 일반 정보 (해당 직무 요구 스킬)
 *   interviewKeywords: string[],     // 예상 면접 질문 키워드
 * }
 * ```
 * 각 항목은 AI 가 모르거나 정보 부족하면 `null` (string 의 경우) 또는 `[]` (배열).
 *
 * **법적 안전장치**:
 * - 화이트리스트 도메인 (`company-research-whitelist.ts`) 외 정보 사용 X
 * - 원문 직접 저장 X — AI 요약만 (derivative work, fair use 강화)
 * - `sources` 에 출처 URL 만 저장. 본문은 X. UI 에서 클릭 시 원본 이동
 * - `opt_out = true` 회사는 조회 시 빈 응답 + cache 영구 차단
 */
@Entity('company_research_cache')
@Index('idx_crc_expires', ['expiresAt'])
export class CompanyResearchCache {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 정규화된 회사명 (lowercase + trim) — 같은 회사 cache 공유 키 */
  @Column({ name: 'company_name', type: 'varchar', length: 120 })
  companyName: string;

  /** 직무 카테고리 (선택 — application.jobCategory). NULL 가능 */
  @Column({
    name: 'job_category',
    type: 'varchar',
    length: 120,
    nullable: true,
  })
  jobCategory: string | null;

  /** AI 가 생성한 8 항목 요약 (read-only, derivative work) */
  @Column({ name: 'ai_research', type: 'jsonb', default: () => "'{}'::jsonb" })
  aiResearch: Record<string, unknown>;

  /** 출처 URL 배열 (본문 X, 사용자 클릭 시 원본 이동) */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  sources: string[];

  /** 90일 TTL — 만료된 row 는 다음 조회 시 갱신 */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** 회사 측 삭제 요청 시 true. 영구 차단 (재조사 안 함) */
  @Column({ name: 'opt_out', type: 'boolean', default: false })
  optOut: boolean;

  /** 캐시 hit 카운트 (admin 통계용 — 가장 자주 조회되는 회사 ranking) */
  @Column({ name: 'hit_count', type: 'int', default: 0 })
  hitCount: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
