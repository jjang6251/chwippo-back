import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Application } from './application.entity';

export type CoverletterChatRole = 'user' | 'assistant';

/**
 * AI 가 답변 제안 시 inline preview + '적용' 버튼에 사용되는 구조.
 * clId 는 백엔드에서 application 의 자식인지 검증 후 응답에 포함.
 */
export interface CoverletterSuggestedUpdate {
  clId: string;
  newAnswer: string;
}

/**
 * Citation 정보 — Notion AI citation 패턴.
 * user role 일 때: 사용자가 선택한 컨텍스트 (사이드 활동 트리)
 * assistant role 일 때: AI 가 활용한 컨텍스트 (응답 hallucination 검증용)
 */
export interface CoverletterCitations {
  /** user role 일 때 — 사용자 선택 log */
  selectedLogIds?: string[];
  /** assistant role 일 때 — AI 활용 log */
  citedLogIds?: string[];
  /** assistant role 일 때 — 회사 조사 활용 여부 */
  citedResearch?: boolean;
}

/**
 * F1 자소서 풀페이지 Phase D — AI 채팅 메시지.
 *
 * DB 영구 + 90일 KST cron 자동 삭제 (옵션 B: application 마지막 활동 + 90일).
 * application CASCADE — 자소서 삭제 시 메시지도 자동 정리.
 * 저장 시 PII 스크럽 (LlmService.scrubPii) 적용.
 */
@Entity('coverletter_chat_messages')
@Index('idx_coverletter_chat_msgs_app_created', ['applicationId', 'createdAt'])
export class CoverletterChatMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'application_id', type: 'uuid' })
  applicationId: string;

  @ManyToOne(() => Application, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'application_id' })
  application?: Application;

  @Column({ type: 'varchar', length: 16 })
  role: CoverletterChatRole;

  /** PII 스크럽 후 저장. char_length 5000 cap. */
  @Column({ type: 'text' })
  content: string;

  /** assistant role 일 때만 — `[{ clId, newAnswer }]` */
  @Column({ name: 'suggested_updates', type: 'jsonb', nullable: true })
  suggestedUpdates: CoverletterSuggestedUpdate[] | null;

  /** Citation (Notion AI 패턴) — Phase G.1. nullable (이전 메시지 호환) */
  @Column({ type: 'jsonb', nullable: true })
  citations: CoverletterCitations | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
