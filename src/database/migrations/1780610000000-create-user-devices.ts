import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W2 RN — Push 인프라 앵커: 사용자 device token 저장.
 *
 * - APNs (iOS) · FCM (Android) · web push subscription 토큰 모두 varchar(500) 로 통합
 *   (FCM ~163 · APNs 64 hex · web endpoint URL 대비 여유).
 * - device_token UNIQUE — 한 디바이스 = 한 row · 재로그인·앱재설치 시 upsert.
 * - ON DELETE CASCADE — user 탈퇴 시 자동 정리.
 * - INDEX (user_id) — 로그아웃 시 user 별 정리 조회.
 * - platform CHECK — 'ios' · 'android' · 'web'.
 *
 * 실제 push 발송은 W3 PR (push_jobs 테이블 · APNs/FCM SDK 통합).
 */
export class CreateUserDevices1780610000000 implements MigrationInterface {
  name = 'CreateUserDevices1780610000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "user_devices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "device_token" varchar(500) NOT NULL,
        "platform" varchar(10) NOT NULL,
        "app_version" varchar(20),
        "last_active_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "pk_user_devices" PRIMARY KEY ("id"),
        CONSTRAINT "uq_user_devices_token" UNIQUE ("device_token"),
        CONSTRAINT "ck_user_devices_platform" CHECK (
          "platform" IN ('ios','android','web')
        ),
        CONSTRAINT "fk_user_devices_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_user_devices_user_id"
        ON "user_devices" ("user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_user_devices_user_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_devices"`);
  }
}
