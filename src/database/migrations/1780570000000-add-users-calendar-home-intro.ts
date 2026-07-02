import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 캘린더 UX 재구성 — 홈 = /calendar redirect 전환.
 *
 * 첫 방문 시 캘린더 상단에 "이제 캘린더가 홈이에요. 회고는 대시보드에서 볼 수 있어요." 안내 배너 노출.
 * 사용자가 dismiss 하면 timestamp 저장 → 이후 재노출 X.
 * 기존 사용자는 nullable 컬럼이라 회귀 영향 없음.
 */
export class AddUsersCalendarHomeIntro1780570000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN calendar_home_intro_dismissed_at TIMESTAMPTZ NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS calendar_home_intro_dismissed_at`,
    );
  }
}
