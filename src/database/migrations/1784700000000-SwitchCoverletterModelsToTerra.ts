import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 1 — 자소서 3종을 GPT-5.6 Terra 로 전환 (2026-08-03, ADR-062).
 *
 * 벤치 결과: 지어내기 **Terra 0건 / Sonnet 5 1건**, 실효 원가 **27원 vs 48원**.
 * 가장 싼 후보가 유일하게 통과해 판정이 그대로 끝났다.
 *
 * 🔴 **"누가 만졌나" 가 아니라 "무엇으로 설정돼 있나" 로 판단한다.**
 *
 * 이 표는 admin 이 화면에서 고치는 곳이라, 마이그레이션이 무조건 덮으면 **사람의 결정을
 * 배포가 조용히 되돌린다.** 그렇다고 `updated_by IS NULL` 로 막으면, 관리자가 **Haiku 를 다시
 * 고른 것뿐인 행**까지 제외돼 자소서 트랙이 갈린다 (초안 Terra · 대화 Haiku — 이번 전환이
 * 막으려던 바로 그 상태다).
 *
 * 그래서 **"아직 이전 모델(Haiku)에 있는 행"** 만 옮긴다:
 *   - 손 안 댄 행 → 옮김 ✅
 *   - 관리자가 Haiku 로 재설정한 행 → 옮김 ✅ (Phase 1 이 그 기본값을 대체한다)
 *   - 관리자가 **다른 모델을 의도적으로 고른 행** → 건드리지 않음 ✅ (진짜 결정이다)
 *
 * `down()` 도 대칭으로 — **지금 Terra 인 행만** Haiku 로 되돌린다. 이 표가 코드보다 우선하므로
 * 행만 되돌려도 즉시 Haiku 로 돌아간다 (G-1 3단 해석).
 */
export class SwitchCoverletterModelsToTerra1784700000000 implements MigrationInterface {
  name = 'SwitchCoverletterModelsToTerra1784700000000';

  private static readonly FEATURES = [
    'coverletter_draft_v2',
    'coverletter_feedback',
    'coverletter_chat',
  ];
  private static readonly FROM = 'claude-haiku-4-5-20251001';
  private static readonly TO = 'gpt-5.6-terra';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const c = SwitchCoverletterModelsToTerra1784700000000;
    await queryRunner.query(
      `UPDATE feature_model_config
          SET provider = 'openai', model = $2, updated_at = now()
        WHERE feature = ANY($1::varchar[])
          AND model = $3`,
      [c.FEATURES, c.TO, c.FROM],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const c = SwitchCoverletterModelsToTerra1784700000000;
    await queryRunner.query(
      `UPDATE feature_model_config
          SET provider = 'anthropic', model = $2, updated_at = now()
        WHERE feature = ANY($1::varchar[])
          AND model = $3`,
      [c.FEATURES, c.FROM, c.TO],
    );
  }
}
