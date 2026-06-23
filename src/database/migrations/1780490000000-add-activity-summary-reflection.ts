import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 활동 총괄 회고 — 이미 끝난 활동을 한꺼번에 wrap up 하는 큰 문단.
 *
 * **베타 피드백** (2026-06-23):
 * 현재 매주 회고 + 한줄/여러줄 log = 진행 중 활동 가정.
 * 단 자소서 소재 80% 가 이미 끝난 활동 (인턴·동아리·프로젝트 등).
 * 끝난 활동은 매주 회고가 어색 — 통째 wrap up 영역 필요.
 *
 * `activities +summary_reflection TEXT NULL` (DB cap 5000자, frontend 강제).
 * NULL = 미작성, 진행중 활동 등 자연.
 */
export class AddActivitySummaryReflection1780490000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE activities ADD COLUMN summary_reflection TEXT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE activities DROP COLUMN IF EXISTS summary_reflection`,
    );
  }
}
