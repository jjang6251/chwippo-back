import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 활동 기록 개편 (activity-redesign) P1.
 *
 * 1. activities.is_inbox — 유저별 숨김 "기본함" 활동 (미분류 로그 컨테이너).
 *    부분 unique 인덱스로 유저당 1개 보장 (get-or-create 동시성 방어).
 * 2. activity_logs.related_step_id — 일정 질문 카드 답변으로 생성된 로그가
 *    어느 전형 스텝에 대한 것인지. ON DELETE SET NULL (스텝 삭제돼도 로그 보존).
 *
 * CEO 결정 2026-07-07: 미분류 = 기본함 방식 (activity_id NOT NULL 유지).
 */
export class ActivityRedesignInboxRestStep1780690000000 implements MigrationInterface {
  name = 'ActivityRedesignInboxRestStep1780690000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "activities" ADD "is_inbox" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_activities_user_inbox" ON "activities" ("user_id") WHERE is_inbox = TRUE`,
    );
    await queryRunner.query(
      `ALTER TABLE "activity_logs" ADD "related_step_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "activity_logs" ADD CONSTRAINT "fk_activity_logs_related_step" FOREIGN KEY ("related_step_id") REFERENCES "application_steps"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "activity_logs" DROP CONSTRAINT "fk_activity_logs_related_step"`,
    );
    await queryRunner.query(
      `ALTER TABLE "activity_logs" DROP COLUMN "related_step_id"`,
    );
    await queryRunner.query(`DROP INDEX "uq_activities_user_inbox"`);
    await queryRunner.query(`ALTER TABLE "activities" DROP COLUMN "is_inbox"`);
  }
}
