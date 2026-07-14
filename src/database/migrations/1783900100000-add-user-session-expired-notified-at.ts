import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 세션 지속성 웨이브 (1차) — 푸시-세션 분리용 dedup/anchor 컬럼.
 *
 * `session_expired_notified_at`:
 *   - 유효 세션 0개 + 디바이스 토큰 살아있는 사용자에게 "로그인 만료" 푸시를 최초 1회
 *     보낸 시각 (중복 방지 dedup).
 *   - 이후 일정 알람은 마스킹 요약으로 발송.
 *   - 이 시각 기준 14일 경과 시 푸시 발송 대상에서 제외.
 *   - 재로그인(세션 생성) 시 NULL 로 리셋 → 실제 알림 재개.
 */
export class AddUserSessionExpiredNotifiedAt1783900100000 implements MigrationInterface {
  name = 'AddUserSessionExpiredNotifiedAt1783900100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "session_expired_notified_at" TIMESTAMPTZ`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "session_expired_notified_at"`,
    );
  }
}
