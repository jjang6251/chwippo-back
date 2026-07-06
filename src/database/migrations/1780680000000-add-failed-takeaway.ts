import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A9 — 탈락 케어 모먼트: "이번 지원에서 얻은 것 한 줄".
 *
 * failed_takeaway    : 탈락 회고 한 줄 (선택 입력 · 나중 추가/수정 허용)
 * failed_takeaway_at : 입력·수정 시각 (성장 페이지 정렬 기준 — status 변경 시각과 분리)
 *
 * 기존 row 는 NULL (기능 도입 전 탈락 — 입력 안 한 것으로 취급).
 */
export class AddFailedTakeaway1780680000000 implements MigrationInterface {
  name = 'AddFailedTakeaway1780680000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD "failed_takeaway" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" ADD "failed_takeaway_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN "failed_takeaway_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN "failed_takeaway"`,
    );
  }
}
