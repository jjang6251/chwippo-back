import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 알림 시스템 — users 알림 설정 3 컬럼.
 *
 * - alarm_config: JSONB (nullable · dashboard_config 패턴). app 에서 default merge.
 *     { master, briefingEnabled, deadlinePoints: 'd1'|'d3'|'d7', deadlineUrgentEnabled }
 *     admin 통지는 config 밖 (opt-out 불가 · system-critical).
 * - alarm_prompted_at: soft-ask 모달을 보여준 시각 (NULL = 아직 안 물어봄 → 로그인 후 모달).
 * - alarm_permission_granted: OS 푸시 권한 실제 허용 여부 (앱 시작 시 getPermissions 로 동기화).
 *
 * 전부 nullable 또는 DEFAULT — 기존 row 안전 (파괴적 변경 아님).
 */
export class AddUserAlarmConfig1780622000000 implements MigrationInterface {
  name = 'AddUserAlarmConfig1780622000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN "alarm_config" jsonb,
        ADD COLUMN "alarm_prompted_at" TIMESTAMPTZ,
        ADD COLUMN "alarm_permission_granted" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "alarm_permission_granted",
        DROP COLUMN IF EXISTS "alarm_prompted_at",
        DROP COLUMN IF EXISTS "alarm_config"
    `);
  }
}
