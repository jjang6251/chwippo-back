import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 퇴역 feature 6개를 `feature_model_config` 에서 제거 (2026-08-03).
 *
 * **왜** — 이 표는 "지금 어떤 모델로 부를까" 설정이지 감사 이력이 아니다. 그런데
 * **한 번도 호출된 적 없는 6개**가 들어 있었다 (dev `llm_call_logs` 전수 + 호출부 grep
 * + `git log -S` 로 확인). G-1 admin 매트릭스가 화면이 되면서 관리자에게 14줄 중 6줄이
 * 죽은 항목으로 노출됐고, 특히 `coverletter` 와 `coverletter_draft_v2` 가 나란히 떠
 * **어느 쪽이 진짜 자소서인지 알 수 없었다**.
 *
 * | 값 | 사유 |
 * |---|---|
 * | `coverletter` · `interview` · `interview_followup` | v1 → v2 로 대체됨 (F6, 2026-05-26) |
 * | `score` · `analysis` | F5 때 선언만 하고 **구현한 적 없음** |
 * | `auto_tag` | `auto-tagger.ts` 가 규칙 기반이라 LLM 불필요 |
 *
 * 🔴 **`llm_call_logs` 는 건드리지 않는다** — 과거 행의 `feature` 값은 감사 기록이라
 * 보존한다. 타입에도 `RetiredLlmFeature` 로 남겨 옛 로그를 읽을 수 있게 했다.
 *
 * `down()` 은 원래 시딩값(1784500000000)을 그대로 되돌린다 — CI 가 down→up 을 검증한다.
 */
export class RemoveRetiredFeatureModelConfigs1784600000000 implements MigrationInterface {
  name = 'RemoveRetiredFeatureModelConfigs1784600000000';

  /** [feature, provider, model] — down 복원용. 1784500000000 SEED 와 동일해야 한다 */
  private static readonly RETIRED: Array<[string, string, string]> = [
    ['auto_tag', 'openai', 'gpt-4o-mini'],
    ['score', 'openai', 'gpt-4o-mini'],
    ['analysis', 'openai', 'gpt-4o-mini'],
    ['coverletter', 'openai', 'gpt-4o-mini'],
    ['interview', 'openai', 'gpt-4o-mini'],
    ['interview_followup', 'openai', 'gpt-4o-mini'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const features = RemoveRetiredFeatureModelConfigs1784600000000.RETIRED.map(
      ([f]) => f,
    );
    await queryRunner.query(
      `DELETE FROM feature_model_config WHERE feature = ANY($1::varchar[])`,
      [features],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [
      feature,
      provider,
      model,
    ] of RemoveRetiredFeatureModelConfigs1784600000000.RETIRED) {
      await queryRunner.query(
        `INSERT INTO feature_model_config (feature, provider, model)
         VALUES ($1, $2, $3)
         ON CONFLICT (feature) DO NOTHING`,
        [feature, provider, model],
      );
    }
  }
}
