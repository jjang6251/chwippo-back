import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A1 Phase 2 — coverletter_feedback (AI 제출 전 점검) 코인 meta.
 *
 * PR_B1 seed 7종에 없었음 (당시 미구현 feature) — row 없으면 charge 가
 * chargesCoins false 취급으로 skip 되어 점검이 무료가 되는 구멍.
 * 가격 정책: 실측 가변 (CEO 확정 2026-07-06) → fixed_coin_cost NULL,
 * avg 는 사전 잔액 체크용 추정 (입력 답변+조사 ~4K + 출력 1.5K ≈ 10코인).
 */
export class AddCoverletterFeedbackCoinMeta1780670000000 implements MigrationInterface {
  name = 'AddCoverletterFeedbackCoinMeta1780670000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO feature_coin_meta (feature, charges_coins, avg_coin_cost, description)
      VALUES ('coverletter_feedback', true, 10, 'AI 제출 전 점검 (짚어주기 — A1 Phase 2)')
      ON CONFLICT (feature) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM feature_coin_meta WHERE feature = 'coverletter_feedback'`,
    );
  }
}
