import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 노트 AI 패널 — `note_ai_action` feature 시드 + 입력 해시 캐시 테이블 (2026-08-19).
 *
 * ## feature 표 3개 (없으면 무슨 일이 나는가)
 *
 * | 표 | 없으면 |
 * |---|---|
 * | `feature_coin_meta` | `chargesCoins` 가 false 취급 → **무료로 새어나간다** + in-flight lock 도 안 걸린다 |
 * | `feature_quota_configs` | 쿼터 체크가 FALLBACK(일 100·쿨다운 60초)으로 떨어진다 — 의도와 다른 한도가 조용히 걸린다 |
 * | `feature_model_config` | admin 화면에 안 뜬다 (호출은 코드 기본값 gpt-5.6-luna 로 동작) |
 *
 * ## 코인 — 토큰 환산 (D1 개정 2026-08-19)
 *
 * `fixed_coin_cost = NULL` — **기본 방식인 토큰 환산 차감** (2026-08-19 CEO 결정: 고정 2 → 환산 전환.
 * 고정은 company_research 만의 예외 경로였고, 환산이 시스템 일관 + 사용자 실질 더 쌈.
 * luna 실측 ~0.5코인/회 (2026-08-19 벤치). 토큰 환산이라 모델을 바꿔도 코인 재계산이 필요 없다.
 * 고정은 company_research 만의 예외 경로였고, 환산이 시스템 일관 + 사용자 실질 더 쌈 ~0.8코인).
 * `avg_coin_cost = 1` 은 사전 잔액 게이트용 추정 (×1.2 버퍼 = 1.2코인 잔여면 진행).
 *
 * ## 쿼터 — 3 tier 전부
 *
 * 다른 feature 는 'free' 행만 있어서 유료 tier 사용자가 FALLBACK 으로 떨어지고 WARN 이 찍힌다.
 * 신규 feature 에서까지 그 상태를 재생산할 이유가 없어 세 tier 를 모두 넣는다.
 * 값은 2026-07-15 쿼터 정책(코인 잔액이 유일한 게이트)에 맞춰 사실상 무제한 + cooldown 0 이다.
 *
 * ## 캐시 테이블
 *
 * 대화를 저장하지 않는 설계(D6)라 새로고침 = 재요청이다. 같은 입력 hash 가 24시간 안에
 * 다시 오면 LLM 을 안 부르고 저장된 마크다운을 돌려준다. 상세 근거는 엔티티 주석 참조.
 *
 * ## 파괴적 변경 아님
 *
 * CREATE + INSERT 만이다. 기존 컬럼·행을 바꾸지 않으므로 2단계 릴리즈 대상이 아니고,
 * down 은 넣은 것만 정확히 되돌린다 (CI 가 down→up 왕복을 검증한다).
 */
export class AddNoteAiAction1786300000000 implements MigrationInterface {
  name = 'AddNoteAiAction1786300000000';

  private static readonly FEATURE = 'note_ai_action';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const f = AddNoteAiAction1786300000000.FEATURE;

    await queryRunner.query(`
      CREATE TABLE note_ai_action_cache (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        resource_type VARCHAR(20) NOT NULL,
        resource_id UUID NOT NULL,
        input_hash VARCHAR(64) NOT NULL,
        result_md TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // 조회 패턴은 "내 것 중 이 hash" 하나뿐 — 만료 정리도 같은 인덱스를 탄다
    await queryRunner.query(`
      CREATE INDEX idx_naac_user_hash ON note_ai_action_cache (user_id, input_hash)
    `);

    await queryRunner.query(
      `INSERT INTO feature_coin_meta
         (feature, charges_coins, avg_coin_cost, fixed_coin_cost, description)
       VALUES ($1, true, 1, NULL, '노트 AI 패널 — 선택 변환·생성 1회 (토큰 환산)')
       ON CONFLICT (feature) DO NOTHING`,
      [f],
    );

    for (const tier of ['free', 'lite', 'standard']) {
      await queryRunner.query(
        `INSERT INTO feature_quota_configs
           (feature, tier, day_limit, month_limit, cooldown_seconds, enabled)
         VALUES ($1, $2, 10000, 100000, 0, true)
         ON CONFLICT (feature, tier) DO NOTHING`,
        [f, tier],
      );
    }

    await queryRunner.query(
      `INSERT INTO feature_model_config (feature, provider, model)
       VALUES ($1, 'openai', 'gpt-5.6-luna')
       ON CONFLICT (feature) DO NOTHING`,
      [f],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const f = AddNoteAiAction1786300000000.FEATURE;
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
    // 인덱스는 DROP TABLE 시 같이 사라진다
    await queryRunner.query(`DROP TABLE IF EXISTS note_ai_action_cache`);
  }
}
