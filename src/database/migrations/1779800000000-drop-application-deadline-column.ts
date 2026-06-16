import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * application.deadline 컬럼 drop — 데이터 모델 통합 마무리.
 *
 * 선행 마이그레이션 1779700000000에서 모든 deadline 데이터를 첫 step.scheduled_date로
 * 이미 옮겨놓음. entity·service·UI에서 deadline 사용처도 모두 정리 완료.
 * 이제 deadline 컬럼은 dead column이므로 drop.
 *
 * down(): 컬럼 복원하지만 데이터 값은 복원 불가 (NULL로 채워짐). 비가역에 가까움.
 */
export class DropApplicationDeadlineColumn1779800000000 implements MigrationInterface {
  name = 'DropApplicationDeadlineColumn1779800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE applications DROP COLUMN IF EXISTS deadline;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE applications ADD COLUMN IF NOT EXISTS deadline date;
    `);
  }
}
