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

  /**
   * 회전 멱등성 — **이 행을 소비한 회전 요청의 id** (클라가 보낸 `rotationId`).
   *
   * 응답 유실로 클라가 같은 낡은 RT 를 다시 낼 때, 같은 `rotationId` 를 들고 오면
   * "새 시도" 가 아니라 **"같은 회전의 재전송"** 임을 알아본다 → 창 안에서 새 토큰 재발급.
   * NULL = 구버전 클라(미전송) 또는 아직 미소비 행 — 둘 다 기존 판정 경로 그대로.
   */
  @Column({ name: 'rotation_id', type: 'uuid', nullable: true })
  rotationId!: string | null;
}
