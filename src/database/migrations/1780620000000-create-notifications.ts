import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 알림 시스템 — 인앱 알림 센터 저장 (헤더 종 아이콘 목록).
 *
 * - cron/admin 이 push 발송 시 이 테이블에도 insert (push 못 받은 사용자 백업 + 히스토리).
 * - type: 'briefing'(아침 브리핑) · 'deadline_urgent'(마감 임박 긴급) · 'admin'(정지/코인/plan 등).
 * - deep_link: 탭 시 이동 경로 (우리 앱 내부 경로만 · 예 '/board/:id').
 * - read: 인앱 센터에서 읽음 처리.
 * - ON DELETE CASCADE — user 탈퇴 시 자동 정리.
 * - INDEX (user_id, created_at DESC) 목록 · partial (user_id) WHERE read=false 안 읽음 카운트.
 */
export class CreateNotifications1780620000000 implements MigrationInterface {
  name = 'CreateNotifications1780620000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "type" varchar(30) NOT NULL,
        "title" varchar(200) NOT NULL,
        "body" text NOT NULL,
        "deep_link" varchar(500),
        "payload" jsonb,
        "read" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "pk_notifications" PRIMARY KEY ("id"),
        CONSTRAINT "ck_notifications_type" CHECK (
          "type" IN ('briefing','deadline_urgent','admin')
        ),
        CONSTRAINT "fk_notifications_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_notifications_user_created"
        ON "notifications" ("user_id", "created_at" DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_notifications_user_unread"
        ON "notifications" ("user_id")
        WHERE "read" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notifications_user_unread"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notifications_user_created"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "notifications"`);
  }
}
