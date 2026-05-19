import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 데이터 모델 통합 — application.deadline → 첫 step.scheduled_date 일원화.
 *
 * 배경: application.deadline(카드 단위 date)과 첫 step.scheduled_date(step datetime)
 * 두 컬럼에 같은 "서류 마감일" 정보가 중복 저장. 사용자가 한쪽만 수정 시 모순 발생.
 *
 * 이 마이그레이션은 데이터를 첫 step.scheduled_date로 일원화. 컬럼 drop은 별도 PR.
 *
 * 영향 케이스:
 *   (1) PLANNED + deadline 있고 step 0개 → 첫 step 생성 + scheduled_date에 복사
 *       (현재 UI는 PLANNED에 deadline 입력 안 받지만 안전망)
 *   (2) IN_PROGRESS 카드 중 첫 step.scheduled_date NULL이고 deadline 있으면 복사
 *       (사용자가 카드 생성 후 deadline만 변경하고 step 비웠던 옛 데이터)
 *
 * 멱등성: IS NULL·HAVING COUNT 조건이라 재실행 안전. down은 noop (역방향 복원 불가능 —
 * 첫 step.scheduled_date가 마이그레이션으로 생긴 건지 사용자가 직접 입력한 건지 구분 불가).
 */
export class MigrateDeadlineToFirstStep1779700000000
  implements MigrationInterface
{
  name = 'MigrateDeadlineToFirstStep1779700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // (1) PLANNED + deadline 있고 step 0개: 첫 step "서류전형" 생성
    await queryRunner.query(`
      INSERT INTO application_steps (id, application_id, name, scheduled_date, order_index)
      SELECT
        gen_random_uuid(),
        a.id,
        '서류전형',
        (a.deadline || ' 00:00:00+09')::timestamptz,
        0
      FROM applications a
      LEFT JOIN application_steps s ON s.application_id = a.id
      WHERE a.deleted_at IS NULL
        AND a.status = 'PLANNED'
        AND a.deadline IS NOT NULL
      GROUP BY a.id, a.deadline
      HAVING COUNT(s.id) = 0;
    `);

    // (2) 첫 step.scheduled_date NULL이고 application.deadline 있으면 복사
    await queryRunner.query(`
      UPDATE application_steps s
      SET scheduled_date = (a.deadline || ' 00:00:00+09')::timestamptz
      FROM applications a
      WHERE s.application_id = a.id
        AND s.order_index = 0
        AND s.scheduled_date IS NULL
        AND a.deadline IS NOT NULL
        AND a.deleted_at IS NULL;
    `);
  }

  public async down(): Promise<void> {
    // 역방향 복원 불가 — 마이그레이션으로 생긴 step과 사용자 입력 step 구분 불가.
    // schema 변경이 없으므로 down은 noop (스키마 일관성 보장).
  }
}
