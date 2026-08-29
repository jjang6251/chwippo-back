import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 직무 출처 관측 컬럼 — `applications.job_title_source` (2026-08-27).
 *
 * ## 왜 필요한가 — 「확정」과 「수용」이 DB 에서 똑같이 보인다
 *
 * 카드 추가 재설계 후 직무는 **세 경로**로 들어온다. 그런데 저장된 결과는 셋 다
 * `job_title = '간호사'` 한 줄로 같다. 이 컬럼이 없으면 아래를 영영 못 가른다.
 *
 * | 값 | 사용자가 한 일 | 신뢰도 |
 * |---|---|---|
 * | `typed` | 직접 타이핑해서 확정 | 가장 높음 |
 * | `suggestion` | 사전 추천 드롭다운에서 탭 | 높음 (고르는 행위 = 확신) |
 * | `prefill` | 온보딩 타이핑 값이 미리 채워진 걸 **그대로 두고** 저장 | 낮음 (묵인일 수 있음) |
 *
 * `prefill` 이 특히 중요하다. 프리필을 안 건드리고 저장한 사용자는 「맞다고 확인」한 걸
 * 수도, 그냥 **폼을 통과시킨** 것일 수도 있다. 둘을 구분 못 하면 프리필 도입이
 * 직무 채움률을 올린 것처럼 보이지만 실제로는 오염만 늘렸을 가능성을 검증할 수 없다.
 *
 * `parsed` 는 **F0(공고 붙여넣기) 예약값**이다. 지금은 아무도 쓰지 않지만 유니온에
 * 미리 넣어두어, 그 기능이 붙을 때 값 추가가 아니라 사용만으로 끝나게 한다.
 *
 * ## 백필하지 않는다
 *
 * 기존 카드는 `NULL`(= 미기록)로 남는다. 도입 이전 카드의 직무가 어느 경로로 들어왔는지는
 * 애초에 경로가 하나뿐이었으므로 `typed` 로 채울 수도 있지만, 그러면 **추측값과 실측값이
 * 같은 컬럼에 섞여** 이 컬럼을 만든 이유가 사라진다. `NULL` 은 "모른다" 라는 정확한 정보다.
 *
 * ## 파괴적 변경 아님
 *
 * nullable 컬럼 ADD 만이다. **읽기 전용 관측용**이라 어떤 동작 분기에도 쓰이지 않으므로
 * 롤백해도 기능 무영향이고 2단계 릴리즈 대상이 아니다. `down` 은 넣은 것만 정확히
 * 되돌린다 — CI 가 down→up 왕복을 검증한다.
 *
 * ## 🔴 인덱스를 만들지 않는 이유
 *
 * 8/25 관측 컬럼(`template_id`·`created_via`)과 같다 — 유일한 소비자는 5분 캐시가 붙은
 * admin 전체 스캔 집계라 인덱스가 도움이 안 되고, 사용자 요청 경로에서는 읽지 않는다.
 */
export class AddJobTitleSource1786600000000 implements MigrationInterface {
  name = 'AddJobTitleSource1786600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE applications
        ADD COLUMN IF NOT EXISTS job_title_source VARCHAR(16)
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN applications.job_title_source IS
        '직무를 어떻게 입력했나(typed·suggestion·prefill·parsed). 관측 전용 · NULL=미기록 또는 도입 이전 카드'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE applications
        DROP COLUMN IF EXISTS job_title_source
    `);
  }
}
