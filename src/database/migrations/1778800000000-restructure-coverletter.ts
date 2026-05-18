import { MigrationInterface, QueryRunner } from 'typeorm';

export class RestructureCoverletter1778800000000 implements MigrationInterface {
  async up(qr: QueryRunner) {
    // 성격 장점/단점 통합 → personality
    await qr.query(
      `ALTER TABLE myinfo_coverletter RENAME COLUMN personality_strength TO personality;`,
    );
    await qr.query(
      `ALTER TABLE myinfo_coverletter DROP COLUMN IF EXISTS personality_weakness;`,
    );
    // 입사 후 포부 제거 (회사별 개별 문항용 — 포괄 소재로는 불필요)
    await qr.query(
      `ALTER TABLE myinfo_coverletter DROP COLUMN IF EXISTS aspiration;`,
    );
    // 범용 소재 항목 추가
    await qr.query(
      `ALTER TABLE myinfo_coverletter ADD COLUMN IF NOT EXISTS collaboration TEXT NULL;`,
    );
    await qr.query(
      `ALTER TABLE myinfo_coverletter ADD COLUMN IF NOT EXISTS challenge TEXT NULL;`,
    );
  }

  async down(qr: QueryRunner) {
    await qr.query(
      `ALTER TABLE myinfo_coverletter DROP COLUMN IF EXISTS challenge;`,
    );
    await qr.query(
      `ALTER TABLE myinfo_coverletter DROP COLUMN IF EXISTS collaboration;`,
    );
    await qr.query(
      `ALTER TABLE myinfo_coverletter ADD COLUMN IF NOT EXISTS aspiration TEXT NULL;`,
    );
    await qr.query(
      `ALTER TABLE myinfo_coverletter ADD COLUMN IF NOT EXISTS personality_weakness TEXT NULL;`,
    );
    await qr.query(
      `ALTER TABLE myinfo_coverletter RENAME COLUMN personality TO personality_strength;`,
    );
  }
}
