import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 탈퇴 집계용 로그 — users 는 hard delete 라 탈퇴 후 조회 불가.
 * 일일 요약의 "24h 탈퇴 수" + 향후 churn 분석용. 개인정보 없음 (userId 미저장 · 카운트만).
 *
 * - provider: 'kakao' · 'apple' · 'kakao+apple' · '-'
 * - source: 'self'(사용자 탈퇴) · 'apple_s2s'(Apple 계정 삭제 알림)
 */
export class CreateUserDeletionLogs1780630000000 implements MigrationInterface {
  name = 'CreateUserDeletionLogs1780630000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "user_deletion_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "provider" varchar(20) NOT NULL,
        "source" varchar(20) NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "pk_user_deletion_logs" PRIMARY KEY ("id"),
        CONSTRAINT "ck_user_deletion_logs_source" CHECK (
          "source" IN ('self','apple_s2s')
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_user_deletion_logs_created"
        ON "user_deletion_logs" ("created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_user_deletion_logs_created"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "user_deletion_logs"`);
  }
}
