import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Application } from './application.entity';

/** 심층 점검(coverletter_feedback) 마지막 결과 — 프론트 계약: camelCase */
export interface CoverletterLastFeedback {
  strengths: string[];
  issues: Array<{ kind: string; quote: string; advice: string }>;
  suggestions: Array<{ target: string; improved: string }>;
  summary: string;
}

// 회사별 자소서 문항-답변 (재활용·AI 컨텍스트용)
@Entity('application_coverletters')
export class ApplicationCoverletter {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'application_id', type: 'uuid' })
  applicationId: string;

  @ManyToOne(() => Application, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'application_id' })
  application: Application;

  @Column({ type: 'text' })
  question: string;

  // 지원동기/성장과정·가치관/입사후포부/직무역량·핵심경험/협업·갈등경험/도전·실패경험/기타
  @Column({ type: 'varchar', nullable: true })
  category: string | null;

  @Column({ type: 'text', nullable: true })
  answer: string | null;

  /**
   * A1 — 답변 최초 출처 (manual/imported/ai_draft). 이후 편집에도 불변.
   * 도입 전 데이터는 NULL (출처 불명).
   */
  @Column({ name: 'answer_origin', type: 'varchar', nullable: true })
  answerOrigin: 'manual' | 'imported' | 'ai_draft' | null;

  // 사용자가 공고 보고 입력하는 글자수 제한 (없으면 무제한)
  @Column({ name: 'char_limit', type: 'int', nullable: true })
  charLimit: number | null;

  @Column({ name: 'order_index', default: 0 })
  orderIndex: number;

  // 심층 점검 결과 영속화 — 모달 닫힘·새로고침 유실 방지 (마지막 status='ok' 결과 1개)
  @Column({ name: 'last_feedback', type: 'jsonb', nullable: true })
  lastFeedback: CoverletterLastFeedback | null;

  @Column({ name: 'last_feedback_at', type: 'timestamptz', nullable: true })
  lastFeedbackAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
