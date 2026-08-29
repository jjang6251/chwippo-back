import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 앱 소개 투어 관측 컬럼 — `users.tour_*` 3개 (2026-08-28 · `plans/app-tour.md`).
 *
 * ## 왜 필요한가 — 「어디서 나갔나」를 알아야 장면을 고칠 수 있다
 *
 * 가입 직후 `/signup/tour` 에서 장면 6개로 앱을 소개한다. 완료율만 재면 **6장 중 어디가
 * 지루한지**를 영영 모른다. 그래서 「끝냈나」와 「어디까지 봤나」를 따로 남긴다.
 *
 * | 컬럼 | 담는 것 | 왜 따로 두나 |
 * |---|---|---|
 * | `tour_seen_at` | **어떤 식으로든** 투어를 끝낸 시각 (건너뛰기 포함) | 「투어를 만난 사람」의 분모 |
 * | `tour_completed_at` | 마지막 장(6)까지 도달한 시각 | `/ops/reach` 깔때기의 「투어 완료」 단계 |
 * | `tour_last_step` | 나간 장면 번호 1~6 | **이탈 장면 분포** — 이게 없으면 완료율 한 숫자만 남는다 |
 *
 * 🔴 **`tour_seen_at` 은 첫 기록만 유지한다** (서비스 `recordTour` 참조). 다시 보기·재진입으로
 * 덮어쓰면 「언제 처음 만났나」가 사라져 코호트 분석이 불가능해진다. 반대로 `tour_last_step` 은
 * **최신값**이다 — 마지막으로 어디까지 갔는지가 알고 싶은 값이다.
 *
 * 🔴 **기존 사용자에게 자동으로 띄우지 않는다.** 이 컬럼이 NULL 이라고 투어를 띄우는 코드는
 * 없다 — 진입은 온보딩 직후 경로와 도움말 링크뿐이다. 가입 직후 오버레이가 이미 4~5겹이라
 * 하나를 더 얹는 대신 **둘(코인 모달·캘린더 배너)을 흡수**하는 게 이 기능의 전제다.
 *
 * ## 🔴 인덱스를 만들지 않는 이유
 *
 * 8/25·8/27·8/28 관측 컬럼과 같다 — 사용자 요청 경로에서는 자기 행 1건을 PK 로 쓸 뿐이고,
 * 집계는 `/ops/reach` 의 전체 스캔(5분 캐시)이라 인덱스가 도움이 안 된다.
 *
 * ## 파괴적 변경 아님
 *
 * nullable 컬럼 ADD 3개뿐이다. 롤백하면 관측값이 사라지지만 스키마·기능은 원상 복구된다
 * (CI 가 down→up 왕복을 검증한다).
 */
export class AddTourColumns1786800000000 implements MigrationInterface {
  name = 'AddTourColumns1786800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS tour_seen_at TIMESTAMPTZ
    `);

    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS tour_completed_at TIMESTAMPTZ
    `);

    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS tour_last_step SMALLINT
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN users.tour_seen_at IS
        '앱 소개 투어를 어떤 식으로든 끝낸 시각(건너뛰기 포함). 첫 기록만 유지 — 덮어쓰면 코호트가 사라진다. NULL=투어를 만난 적 없음'
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN users.tour_completed_at IS
        '앱 소개 투어 마지막 장(6) 도달 시각. /ops/reach 깔때기의 「투어 완료」 단계'
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN users.tour_last_step IS
        '앱 소개 투어에서 마지막으로 본 장면(1~6) — 이탈 장면 분포용. 최신값으로 갱신'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS tour_last_step
    `);

    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS tour_completed_at
    `);

    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS tour_seen_at
    `);
  }
}
