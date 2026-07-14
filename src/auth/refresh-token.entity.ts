import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/**
 * 세션 지속성 웨이브 (B안 — 토큰 패밀리) — 발급 refresh token 마다 1행.
 *
 * rotation 마다 새 행 INSERT · 소비 시 `used_at` 마킹 (재사용=탈취 판정의 정본).
 *
 * - `session_id` = 소속 `refresh_sessions.id` (기기 체인). 세션 revoke 시 join 으로 일괄 무효
 * - `token_hash` = refresh token 의 SHA-256 hex (평문 저장 금지 · §2.4.1 승계) · 전역 UNIQUE
 * - `used_at` = rotation 소비 시각. NULL = 미사용(유효) / NOT NULL = 이미 소비됨(재사용 감지 대상)
 * - session FK ON DELETE CASCADE — 세션 삭제 시 자동 정리 (cron: 만료·revoked 세션 삭제)
 * - 소비된 토큰은 cron 이 used_at +7일 경과 시 삭제 (테이블 팽창 방지 · 최근분만 감지에 유지)
 */
@Entity('refresh_tokens')
@Index(['sessionId'])
export class RefreshToken {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId!: string;

  /** refresh token 의 SHA-256 hex (64자) · 전역 UNIQUE (조회 키) */
  @Column({ name: 'token_hash', type: 'varchar', length: 64, unique: true })
  tokenHash!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** rotation 소비 시각. NULL=미사용(유효), NOT NULL=소비됨(재사용 시 탈취/경합 판정) */
  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt!: Date | null;
}
