import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 쿼터 정책 웨이브 B — 코인 차감 6종의 일/월 한도를 사실상 무제한 + 쿨다운 0 으로 (CEO 결정 2026-07-13).
 *
 * 원칙: "코인이 지키는 곳만 한도 제거" — 코인으로 비용이 통제되는 feature 는
 * 일/월 횟수 한도·쿨다운을 걷어내고, 코인 잔액이 유일한 게이트가 되게 한다.
 * 동시호출 방어는 LlmService in-flight lock (웨이브 C), 이상 사용은 Discord 감시(웨이브 D)로 이관.
 *
 * **값만 변경** (스키마 무변경) — CHECK 상한(day 0-10000·month 10-100000·cooldown 0-3600) 내.
 * 존재하는 전 tier 행 UPDATE (현재 'free' 만 존재. lite/standard 도입 시 자동 포함 위해 tier 필터 없음).
 *
 * | feature                  | before (day/month/cooldown) | after            |
 * |--------------------------|-----------------------------|------------------|
 * | coverletter_chat         | 100 / 1000 / 10             | 10000/100000/0   |
 * | coverletter_draft_v2     | 1000 / 10000 / 120          | 10000/100000/0   |
 * | coverletter_feedback     | 1000 / 10000 / 120          | 10000/100000/0   |
 * | coverletter_recommend    | 1000 / 10000 / 60           | 10000/100000/0   |
 * | interview_prep_session   | 1000 / 10000 / 300          | 10000/100000/0   |
 * | interview_prep_followup  | 1000 / 10000 / 60           | 10000/100000/0   |
 *
 * 코인 미차감(note_summary·jobposting_parse) 무변경.
 * down(): 각 feature 원래값 복원 (CI down→up 검증 대응).
 */
export class UpdateCoinFeatureQuotaValues1784000000000 implements MigrationInterface {
  name = 'UpdateCoinFeatureQuotaValues1784000000000';

  private static readonly COIN_FEATURES = [
    'coverletter_chat',
    'coverletter_draft_v2',
    'coverletter_feedback',
    'coverletter_recommend',
    'interview_prep_session',
    'interview_prep_followup',
  ];

  /** down() 복원용 — feature별 마이그레이션 seed 원래값 [day, month, cooldown] */
  private static readonly ORIGINAL: Record<string, [number, number, number]> = {
    coverletter_chat: [100, 1000, 10],
    coverletter_draft_v2: [1000, 10000, 120],
    coverletter_feedback: [1000, 10000, 120],
    coverletter_recommend: [1000, 10000, 60],
    interview_prep_session: [1000, 10000, 300],
    interview_prep_followup: [1000, 10000, 60],
  };

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE feature_quota_configs
         SET day_limit = 10000, month_limit = 100000, cooldown_seconds = 0, updated_at = now()
       WHERE feature = ANY($1)`,
      [UpdateCoinFeatureQuotaValues1784000000000.COIN_FEATURES],
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const [feature, [day, month, cooldown]] of Object.entries(
      UpdateCoinFeatureQuotaValues1784000000000.ORIGINAL,
    )) {
      await queryRunner.query(
        `UPDATE feature_quota_configs
           SET day_limit = $2, month_limit = $3, cooldown_seconds = $4, updated_at = now()
         WHERE feature = $1`,
        [feature, day, month, cooldown],
      );
    }
  }
}
