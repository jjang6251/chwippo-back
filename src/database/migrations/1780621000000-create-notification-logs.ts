import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 알림 시스템 — 발송 로그 + 중복 발송 방지.
 *
 * ⚠️ dedup UNIQUE 는 반드시 **KST 날짜** 기준.
 *   08:00 KST 발송 = 전날 23:00 UTC. UTC 날짜로 dedup 하면 재시도 시
 *   UTC 날짜가 달라져 같은 브리핑이 2번 나갈 수 있음.
 *   → `((sent_at AT TIME ZONE 'Asia/Seoul')::date)` expression UNIQUE.
 *
 * - push_response: Expo push ticket/receipt (디버깅·재전송 판단).
 * - ON DELETE CASCADE — user 탈퇴 시 자동 정리.
 */
export class CreateNotificationLogs1780621000000 implements MigrationInterface {
  name = 'CreateNotificationLogs1780621000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "notification_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "type" varchar(30) NOT NULL,
        "sent_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "push_response" jsonb,
        CONSTRAINT "pk_notification_logs" PRIMARY KEY ("id"),
        CONSTRAINT "ck_notification_logs_type" CHECK (
          "type" IN ('briefing','deadline_urgent','admin')
        ),
        CONSTRAINT "fk_notification_logs_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    // 같은 user·type 은 KST 하루 1회만 (중복 발송 방지).
    // admin type 은 여러 번 발송 가능해야 하므로 dedup 대상 아님 → briefing·deadline_urgent 만.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_notification_logs_daily_dedup"
        ON "notification_logs" (
          "user_id",
          "type",
          (("sent_at" AT TIME ZONE 'Asia/Seoul')::date)
        )
        WHERE "type" IN ('briefing','deadline_urgent')
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_notification_logs_sent_at"
        ON "notification_logs" ("sent_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notification_logs_sent_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_notification_logs_daily_dedup"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_logs"`);
  }
}
