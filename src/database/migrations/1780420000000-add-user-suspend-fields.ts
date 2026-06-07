import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR_B2 Phase 1 — users +suspend_reason +suspend_expires_at.
 *
 * **Q13**: 정지 모달에 사유 + 정지 시점 + 예상 해제일 표시.
 *
 * - `suspend_reason TEXT NULL` — admin 입력 사유 (1..500자). NULL 이면 사유 미지정 (legacy 호환)
 * - `suspend_expires_at TIMESTAMPTZ NULL` — 자동 해제 시간. NULL = 영구 정지
 *
 * 정지 상태: `suspended_at IS NOT NULL`.
 * 자동 해제: 매시간 cron (UnsuspendCron) + lazy (me 호출 시 expires_at < NOW 면 즉시 해제).
 */
export class AddUserSuspendFields1780420000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN suspend_reason TEXT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN suspend_expires_at TIMESTAMPTZ NULL`,
    );
    // 자동 해제 cron 의 효율 인덱스 (만료 임박 users 만 스캔)
    await queryRunner.query(
      `CREATE INDEX idx_users_suspend_expires_at ON users (suspend_expires_at)
       WHERE suspended_at IS NOT NULL AND suspend_expires_at IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_users_suspend_expires_at`,
    );
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS suspend_expires_at`,
    );
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS suspend_reason`,
    );
  }
}
