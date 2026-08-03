import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G-1 (2026-08-02) — `feature_model_config` 신설. feature 별 LLM 모델을 DB 로.
 *
 * **왜**: 모델이 env 2개로만 정해져 자소서 3종과 면접이 같은 값을 공유했다.
 * "자소서만 상위 모델" 이 불가능했고, 바꾸려면 재배포라 롤백 경로도 없었다.
 *
 * 🔴 **시딩 값은 현행 해석 결과 그대로다** — 배포 즉시 동작이 1도 안 바뀐다.
 * anthropic 계열은 `claude-haiku-4-5-20251001`(정식 id) 로 넣는다. 현재 env 가
 * 그 값을 주고 있어서, DB 우선으로 바뀌어도 실제 호출 모델이 동일하다.
 *
 * - `updated_by` FK **ON DELETE SET NULL** — 관리자가 탈퇴해도 설정은 보존.
 *   CASCADE 면 설정 행이 사라져 그 feature 가 조용히 폴백된다
 * - 인덱스 없음 — PK(`feature`) 단독 조회만 한다
 * - 신규 테이블이라 파괴적 변경 없음 → 2단계 릴리즈 불필요
 *
 * ⚠️ **`migration:generate` 를 쓰지 말 것** — 이 레포는 엔티티(`string`)와 DB(`uuid`·
 * `timestamptz`) 사이에 구조적 drift 가 있어 generate 가 파괴적 diff 를 만든다.
 * 이 레포의 마이그레이션은 전부 손으로 쓴다.
 */
export class CreateFeatureModelConfig1784500000000 implements MigrationInterface {
  name = 'CreateFeatureModelConfig1784500000000';

  /** 현행 `FEATURE_MATRIX` 해석 결과 (provider, model) — 시딩 = 무변화 보장 */
  private static readonly SEED: Array<[string, string, string]> = [
    ['note_summary', 'openai', 'gpt-4o-mini'],
    ['auto_tag', 'openai', 'gpt-4o-mini'],
    ['score', 'openai', 'gpt-4o-mini'],
    ['analysis', 'openai', 'gpt-4o-mini'],
    ['coverletter', 'openai', 'gpt-4o-mini'],
    ['interview', 'openai', 'gpt-4o-mini'],
    ['interview_followup', 'openai', 'gpt-4o-mini'],
    ['coverletter_draft_v2', 'anthropic', 'claude-haiku-4-5-20251001'],
    ['coverletter_feedback', 'anthropic', 'claude-haiku-4-5-20251001'],
    ['coverletter_recommend', 'openai', 'gpt-4o-mini'],
    ['interview_prep_session', 'anthropic', 'claude-haiku-4-5-20251001'],
    ['interview_prep_followup', 'openai', 'gpt-4o-mini'],
    ['coverletter_chat', 'anthropic', 'claude-haiku-4-5-20251001'],
    ['jobposting_parse', 'openai', 'gpt-4o-mini'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS feature_model_config (
        feature     VARCHAR(50) PRIMARY KEY,
        provider    VARCHAR(20) NOT NULL,
        model       VARCHAR(60) NOT NULL,
        updated_by  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    for (const [
      feature,
      provider,
      model,
    ] of CreateFeatureModelConfig1784500000000.SEED) {
      await queryRunner.query(
        `INSERT INTO feature_model_config (feature, provider, model)
         VALUES ($1, $2, $3)
         ON CONFLICT (feature) DO NOTHING`,
        [feature, provider, model],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // reversible — 테이블을 통째로 제거하면 코드가 env → 기본값 폴백으로 돌아간다
    await queryRunner.query(`DROP TABLE IF EXISTS feature_model_config`);
  }
}
