import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `coverletter_chat` feature 의 quota config row 추가.
 *
 * chat feature 추가 시 config row INSERT 누락 → FALLBACK(60초) 으로 동작하던 것을
 * 정식화. 대화형 기능이라 쿨타임 10초 (광클 방지 최소 — 실질 비용 제한은 코인).
 * CEO 결정 2026-07-09.
 *
 * - PK (feature, tier) — 기존 feature 들과 동일하게 'free' tier row 만 추가.
 * - ON CONFLICT DO NOTHING — 운영에 admin 이 이미 만들어뒀을 가능성 대비 idempotent.
 */
export class AddCoverletterChatQuotaConfig1780730000000 implements MigrationInterface {
  name = 'AddCoverletterChatQuotaConfig1780730000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO feature_quota_configs
        (feature, tier, day_limit, month_limit, cooldown_seconds, enabled)
      VALUES ('coverletter_chat', 'free', 100, 1000, 10, TRUE)
      ON CONFLICT (feature, tier) DO NOTHING
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM feature_quota_configs
      WHERE feature = 'coverletter_chat' AND tier = 'free'
    `);
  }
}
