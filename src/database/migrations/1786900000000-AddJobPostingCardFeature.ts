import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 공고 → 카드 (대장 21) — feature `jobposting_card` 등록 (2026-08-29).
 *
 * ## 세 가지를 한 마이그레이션에 넣는 이유
 *
 * 셋은 **같은 한 가지 사실**의 세 면이다 — 「`jobposting_card` 라는 LLM feature 가 존재한다」.
 * 나눠 놓으면 quota 행만 들어가고 model 행이 빠진 중간 상태가 배포될 수 있고, 그 상태에서
 * 호출이 들어오면 `FALLBACK_CONFIG`(일 100·쿨다운 60초) 가 조용히 적용된다 — 설계값과
 * 다른 한도가 **경고 없이** 작동하는 셈이다.
 *
 * ## 「한도 없음」을 코드가 아니라 admin 값으로 적는다
 *
 * CEO 결정 4 = 「제한 두지 말고 비용 측정 빡세게」. 그래서 **코드에서 quota 체크를 건너뛰지
 * 않는다** — 모든 LLM caller 는 admin 페이지에서 100% 통제 가능해야 한다는 원칙이 우선이고,
 * 우회 코드는 그 원칙에 구멍을 낸다. 대신 사람이 닿지 않는 값을 넣는다:
 *
 * | 값 | 근거 |
 * |---|---|
 * | day 200 | 사람은 하루에 공고 200개를 붙여넣지 않는다. 최악 400원/일/계정 (호출당 실측 ≈0.7원 · 최대 1.5원) |
 * | month 3,000 | day 200 × 15일. `day <= month` invariant 충족 |
 * | cooldown 0 | 연속 붙여넣기가 정상 사용이다 (동시 3장) |
 * | enabled TRUE | 🔴 **킬 스위치** — 사고 시 재배포 없이 admin 에서 즉시 끈다 |
 *
 * ## `jobposting_parse` 5 → 200 을 여기서 같이 올린다
 *
 * 「공고 정리 AI 도 무료로 풀까」(CEO 8/29) → 이미 코인 0 이었고 막고 있던 건 **일 5회**뿐이다.
 * 공고로 카드를 만들면 요건 정리가 자동으로 따라오는데, 카드 경로는 200 이고 수동 정리만 5 면
 * 「같은 일을 어디서 하느냐에 따라 한도가 다른」 상태가 된다. `down()` 은 **5 로 정확히
 * 되돌린다** — 되돌린 뒤에도 이 기능 이전과 같은 상태여야 한다.
 *
 * ## 파괴적 변경 아님
 *
 * INSERT 2 + UPDATE 1. 컬럼·테이블 변경 0. `down()` 은 넣은 것만 지우고 바꾼 것만 되돌린다
 * (CI 가 down→up 왕복을 검증한다).
 */
export class AddJobPostingCardFeature1786900000000 implements MigrationInterface {
  name = 'AddJobPostingCardFeature1786900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ① quota — 사용자 체감 제한 없음 = 사람이 못 닿는 admin 값 (봇 상한)
    await queryRunner.query(`
      INSERT INTO feature_quota_configs
        (feature, tier, day_limit, month_limit, cooldown_seconds, enabled)
      VALUES ('jobposting_card', 'free', 200, 3000, 0, TRUE)
      ON CONFLICT (feature, tier) DO NOTHING
    `);

    // ② 모델 — 현행 해석 결과 그대로 (gpt-4o-mini). admin `feature_model_config` 로 무배포 교체
    await queryRunner.query(`
      INSERT INTO feature_model_config (feature, provider, model)
      VALUES ('jobposting_card', 'openai', 'gpt-4o-mini')
      ON CONFLICT (feature) DO NOTHING
    `);

    // ③ 기존 공고 요건 정리도 같은 정책으로 — 일 5 → 200 (코인은 원래 0)
    await queryRunner.query(`
      UPDATE feature_quota_configs
         SET day_limit = 200
       WHERE feature = 'jobposting_parse' AND tier = 'free'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 되돌리면 기존 파서는 **정확히 이전 값(5)** 으로 — 신설 이전과 같은 상태여야 한다
    await queryRunner.query(`
      UPDATE feature_quota_configs
         SET day_limit = 5
       WHERE feature = 'jobposting_parse' AND tier = 'free'
    `);
    await queryRunner.query(`
      DELETE FROM feature_model_config WHERE feature = 'jobposting_card'
    `);
    await queryRunner.query(`
      DELETE FROM feature_quota_configs
       WHERE feature = 'jobposting_card' AND tier = 'free'
    `);
  }
}
