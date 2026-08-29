import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 온보딩 계열·직무 컬럼 — `users.signup_series_id` · `users.signup_job_title` (2026-08-28).
 *
 * ## 왜 필요한가 — 21개 직군 칩이 계열 1탭으로 바뀐다
 *
 * 가입 온보딩이 「직군 여러 개 고르기」에서 **「계열 하나 + (선택) 직무 타이핑」**으로
 * 바뀐다. 기존 `signup_job_categories`(JSONB)는 21개 칩 값을 담는 그릇이라 새 답을
 * 그대로 넣을 수 없다 — 계열 id 는 ASCII 안정키고, 직무는 사람이 친 원문이다.
 *
 * | 컬럼 | 담는 것 | 왜 따로 두나 |
 * |---|---|---|
 * | `signup_series_id` | 계열 id (`it`·`health`…) | 콘텐츠 매칭 축. 라벨이 바뀌어도 안 바뀌는 키 |
 * | `signup_job_title` | 사람이 타이핑한 직무 원문 | **카드 프리필의 재료**. 계열 라벨은 여기 오지 않는다 |
 *
 * 🔴 **「사람 말만 볼펜」** — `signup_job_title` 에는 사용자가 **직접 친 말만** 들어간다.
 * 계열만 고른 사용자는 이 값이 NULL 이고, 그래서 카드 추가 모달에 프리필이 뜨지 않는다.
 * 시스템이 고른 라벨을 직무로 승격하면 예전 「직군 칩 자동 선택」 오염의 재판이 된다.
 *
 * ## 기존 컬럼은 그대로 둔다
 *
 * `signup_job_categories` 는 **삭제하지 않는다.** 「이미 답변했나」 판정이 그 컬럼의
 * NULL 여부로 되어 있고(새 경로도 `[]` 를 기록해 그 판정을 유지한다), 이미 답한
 * 사용자 수십 명의 값이 관측 자산이다. 파괴적 변경 없이 옆에 나란히 붙인다.
 *
 * ## 파괴적 변경 아님
 *
 * nullable 컬럼 ADD 2개뿐이다. 롤백하면 새 온보딩의 답이 사라지지만 스키마·기능은
 * 원상 복구된다 (`down` 은 넣은 것만 정확히 되돌린다 — CI 가 down→up 왕복을 검증한다).
 *
 * ## 🔴 인덱스를 만들지 않는 이유
 *
 * 8/25·8/27 관측 컬럼과 같다 — 사용자 요청 경로에서는 자기 행 1건을 PK 로 읽을 뿐이고,
 * 집계는 admin 전체 스캔(5분 캐시)이라 인덱스가 도움이 안 된다.
 */
export class AddSignupSeriesAndJobTitle1786700000000 implements MigrationInterface {
  name = 'AddSignupSeriesAndJobTitle1786700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS signup_series_id VARCHAR(24)
    `);

    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS signup_job_title VARCHAR(100)
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN users.signup_series_id IS
        '온보딩 계열 id (프론트 JOB_SERIES id). NULL=미답변 또는 건너뛰기'
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN users.signup_job_title IS
        '온보딩에서 사람이 타이핑한 직무 원문 — 카드 프리필 재료. 계열 라벨은 여기 오지 않는다(사람 말만 볼펜)'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS signup_job_title
    `);

    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS signup_series_id
    `);
  }
}
