import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * R4 — Expo push 영수증 확인 대기열 (2026-08-13).
 *
 * ## 왜
 *
 * 죽은 토큰 정리가 발송 **티켓**의 `DeviceNotRegistered` 만 보고 있었다.
 * 그런데 FCM 은 그 에러를 대개 **영수증(receipt)** 단계에서 준다 —
 * 그래서 앱을 지운 안드로이드 기기의 행이 계속 남았다 (실측: 한 계정에 시체 4행).
 * 그 시체가 multi-device 오탐 알람의 원인이기도 했다.
 *
 * ## 설계
 *
 * | 결정 | 이유 |
 * |---|---|
 * | `ticket_id UNIQUE` | 같은 티켓을 두 번 적으면 영수증을 두 번 조회한다. 저장 자체가 멱등해야 함 |
 * | `device_token` FK 없음 | 발송~영수증 사이에 로그아웃으로 user_devices 행이 먼저 사라질 수 있다. FK 면 그 경합이 에러가 된다 |
 * | `processed_at NULL` | 미처리 표식. Expo 장애 시 안 찍고 넘어가면 다음 주기가 자동 재시도 |
 * | `INDEX (processed_at, created_at)` | 유일한 조회 패턴이 "미처리 중 15분 지난 것" 하나뿐 |
 *
 * 보관은 7일 — Expo 영수증 자체가 약 하루면 만료되므로 그 뒤로는 조회해도 답이 없다.
 */
export class CreatePushReceipts1785900000000 implements MigrationInterface {
  name = 'CreatePushReceipts1785900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "push_receipts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ticket_id" varchar(100) NOT NULL,
        "device_token" varchar(500) NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "processed_at" TIMESTAMPTZ,
        CONSTRAINT "pk_push_receipts" PRIMARY KEY ("id"),
        CONSTRAINT "uq_push_receipts_ticket" UNIQUE ("ticket_id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_push_receipts_pending"
        ON "push_receipts" ("processed_at", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // reversible — CI 가 down→up 왕복을 검증한다. 대기열 데이터는 복구 대상이 아니다
    // (영수증은 하루면 만료되므로 되돌린 뒤 다시 쌓으면 그만).
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_push_receipts_pending"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "push_receipts"`);
  }
}
