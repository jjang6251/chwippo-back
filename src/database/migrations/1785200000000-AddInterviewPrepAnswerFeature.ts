import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 면접 prep v2 — `interview_prep_answer` feature 시드 (2026-08-06).
 *
 * 세션·꼬리질문이 **질문만** 만들게 되면서, 사용자가 `AI 도움` 을 눌렀을 때 답변 1개를
 * 만드는 feature 가 새로 필요해졌다. 표 3개에 행이 있어야 정상 동작한다:
 *
 * | 표 | 없으면 |
 * |---|---|
 * | `feature_coin_meta` | `chargesCoins` 가 false 취급 → **무료로 새어나간다** |
 * | `feature_quota_configs` | 쿼터 체크가 기본값으로 떨어진다 |
 * | `feature_model_config` | admin 화면에 안 뜬다 (호출은 코드 기본값으로 동작) |
 *
 * ## 코인 단가 산정 (실측 기반)
 *
 * luna 단가 $0.2/$1.2 → `weight` 0.2 · `outRatio` 6.
 * 벤치 실측 기준 답변 1건 ≈ 입력 2,000 · 출력 600(본문 273 + 추론 몫).
 *   equivalent = 2,000 + 600×6 = 5,600 → `ceil(5600×0.2/100)/10` = **1.2 코인**
 * `avg_coin_cost` 는 **사전 잔액 체크용 추정**이라 보수적으로 2 로 둔다.
 *
 * ## 🔴 `interview_prep_session` 의 avg 도 함께 내린다
 *
 * 기존 값 10 은 haiku + 질문·답변 동시 생성 시절의 추정이다. v2(luna·질문만)의 실측은
 * 약 1.9 코인이라, 10 을 그대로 두면 **잔액이 2~9 인 사용자가 쓸 수 있는데도 사전 체크에서
 * 막힌다.** 모델·범위가 바뀌면 이 값도 따라와야 한다.
 *
 * ## 쿼터
 *
 * 다른 면접 feature 와 같은 정책 — day 10000 / month 100000 / cooldown 0.
 * 2026-07-15 쿼터 정책 웨이브에서 **코인 잔액을 유일한 게이트**로 바꿨기 때문에,
 * 여기만 cooldown 을 넣으면 정책이 갈린다.
 */
export class AddInterviewPrepAnswerFeature1785200000000 implements MigrationInterface {
  name = 'AddInterviewPrepAnswerFeature1785200000000';

  private static readonly FEATURE = 'interview_prep_answer';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const f = AddInterviewPrepAnswerFeature1785200000000.FEATURE;

    await queryRunner.query(
      `INSERT INTO feature_coin_meta (feature, charges_coins, avg_coin_cost, description)
       VALUES ($1, true, 2, '면접 예상 답변 1개 생성 (v2 on-demand)')
       ON CONFLICT (feature) DO NOTHING`,
      [f],
    );

    // v2 로 원가가 1/5 로 줄었다 — 사전 잔액 체크가 과하게 막지 않도록 함께 조정
    await queryRunner.query(
      `UPDATE feature_coin_meta
          SET avg_coin_cost = 2, updated_at = now()
        WHERE feature = 'interview_prep_session' AND avg_coin_cost > 2`,
    );

    await queryRunner.query(
      `INSERT INTO feature_quota_configs
         (feature, tier, day_limit, month_limit, cooldown_seconds, enabled)
       VALUES ($1, 'free', 10000, 100000, 0, true)
       ON CONFLICT (feature, tier) DO NOTHING`,
      [f],
    );

    await queryRunner.query(
      `INSERT INTO feature_model_config (feature, provider, model)
       VALUES ($1, 'openai', 'gpt-5.6-luna')
       ON CONFLICT (feature) DO NOTHING`,
      [f],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const f = AddInterviewPrepAnswerFeature1785200000000.FEATURE;
    // 🔴 `interview_prep_session` 의 avg 는 되돌리지 않는다 — v2 모델·범위가 그대로면
    //   10 으로 되돌리는 게 오히려 틀린 값이다. 모델 전환은 별도 마이그레이션이 관리한다.
    await queryRunner.query(
      `DELETE FROM feature_model_config WHERE feature = $1`,
      [f],
    );
    await queryRunner.query(
      `DELETE FROM feature_quota_configs WHERE feature = $1`,
      [f],
    );
    await queryRunner.query(
      `DELETE FROM feature_coin_meta WHERE feature = $1`,
      [f],
    );
  }
}
