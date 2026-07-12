import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * legacy/deprecated 6 feature 의 quota config 행 삭제 (2026-07-13 CEO 지시).
 *
 * 근거: 백엔드 전수 검색 결과 6종 전부 LlmService 호출 경로 0건 —
 * 죽은 설정 행이 admin AI 한도 페이지 "기타" 카드로 노출되는 것만 정리.
 * LlmFeature 타입·한국어 라벨은 운영 llm_call_logs 과거 이력 표시용으로 유지.
 *
 * down(): 최초 seed(1779960000000)와 동일 값으로 복원 — CI down→up 검증 대응.
 */
export class RemoveLegacyQuotaConfigs1783823000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM feature_quota_configs
        WHERE feature IN ('coverletter', 'interview', 'interview_followup', 'score', 'analysis', 'auto_tag')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const seeds: Array<[string, number]> = [
      ['coverletter', 60],
      ['interview', 60],
      ['interview_followup', 60],
      ['score', 30],
      ['analysis', 30],
      ['auto_tag', 30],
    ];
    for (const [feature, cooldown] of seeds) {
      await queryRunner.query(
        `INSERT INTO feature_quota_configs
          (feature, tier, day_limit, month_limit, cooldown_seconds, enabled)
         VALUES ($1, 'free', 1000, 10000, $2, TRUE)
         ON CONFLICT DO NOTHING`,
        [feature, cooldown],
      );
    }
  }
}
