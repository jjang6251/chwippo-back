import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR_B2 Phase 1 — users +pending_notification JSONB (Q24 사용자 통지 정책).
 *
 * admin 액션 (코인 grant / revoke / 매트릭스 immediate / tier downgrade·upgrade) 후
 * 사용자에게 모달 1회 노출.
 *
 * **구조**:
 * ```jsonc
 * {
 *   "type": "coin_grant" | "coin_revoke" | "matrix_change" | "tier_downgrade" | "tier_upgrade",
 *   "title": "코인이 지급되었어요",
 *   "body": "사유: 환불 / +50 코인",
 *   "createdAt": "2026-06-08T03:00:00Z"
 * }
 * ```
 *
 * **흐름**:
 * 1. admin 액션 → users.pending_notification = {...}
 * 2. 사용자 me 호출 응답에 포함 → frontend UserNotificationModal 표시
 * 3. dismiss API (`POST /me/notifications/dismiss`) → NULL 처리
 *
 * 신규 통지가 기존 dismiss 안 된 통지를 덮어쓰는 정책 (최신 우선).
 */
export class AddUserPendingNotification1780421000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN pending_notification JSONB NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS pending_notification`,
    );
  }
}
