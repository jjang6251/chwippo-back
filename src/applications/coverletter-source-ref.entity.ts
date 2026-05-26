import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ActivityLog } from '../activity/entities/activity-log.entity';
import { ActivityReflection } from '../activity/entities/activity-reflection.entity';
import { ApplicationCoverletter } from './application-coverletter.entity';

/**
 * F6 PR 1 — application_coverletter ↔ activity_log/reflection 참조 (N:M).
 *
 * 한 row 는 `sourceLogId XOR sourceReflectionId` 중 하나만 보유 (DB CHECK 제약).
 * Phase 2 의 컨텍스트 빌더 v2 가 이 테이블을 통해 자소서 본문에 인용된 로그/회고를 추적.
 * F5 hard delete 가드 (assertNoSourceRefs) 가 이 테이블 COUNT 로 차단 판정.
 */
@Entity('coverletter_source_refs')
@Index('idx_csr_coverletter', ['coverletterId'])
export class CoverletterSourceRef {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'coverletter_id', type: 'uuid' })
  coverletterId: string;

  @ManyToOne(() => ApplicationCoverletter, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'coverletter_id' })
  coverletter: ApplicationCoverletter;

  /** XOR with sourceReflectionId — DB CHECK 제약 + Service 단 가드 */
  @Column({ name: 'source_log_id', type: 'uuid', nullable: true })
  sourceLogId: string | null;

  @ManyToOne(() => ActivityLog, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'source_log_id' })
  sourceLog: ActivityLog | null;

  @Column({ name: 'source_reflection_id', type: 'uuid', nullable: true })
  sourceReflectionId: string | null;

  @ManyToOne(() => ActivityReflection, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'source_reflection_id' })
  sourceReflection: ActivityReflection | null;

  /** partial 참조 시 본문 일부 캐시 (선택, 사이드 패널 표시용) */
  @Column({ name: 'snippet_text', type: 'text', nullable: true })
  snippetText: string | null;

  /** partial 범위 (UI 결정 schema, 백은 raw 저장). 예: `{paragraph: 2, start: 0, end: 30}` */
  @Column({ name: 'partial_range', type: 'jsonb', nullable: true })
  partialRange: Record<string, unknown> | null;

  /** AI 자동 추천 vs 사용자 명시 선택 (사이드 패널의 "AI 추천 칩" 표시 결정) */
  @Column({ name: 'ai_recommended', type: 'boolean', default: false })
  aiRecommended: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
