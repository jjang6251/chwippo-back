import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR_B2 Phase 0.3 — admin_audit_logs +ip +user_agent.
 *
 * Q4 강화 — 모든 admin 액션의 출처 (IP / UA) 영구 보존.
 * 운영 사고 시 admin 계정 탈취 / 비정상 IP 변경 / 비활동 시간대 액션 추적 가능.
 *
 * 신규 row 부터 채움. 기존 row 는 NULL (정상).
 */
export class AddAuditIpUa1780410000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE admin_audit_logs ADD COLUMN ip TEXT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE admin_audit_logs ADD COLUMN user_agent TEXT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE admin_audit_logs DROP COLUMN IF EXISTS user_agent`,
    );
    await queryRunner.query(
      `ALTER TABLE admin_audit_logs DROP COLUMN IF EXISTS ip`,
    );
  }
}
