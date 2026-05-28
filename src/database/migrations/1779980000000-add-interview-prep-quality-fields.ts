import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F6 PR 2 Phase 4 — 면접 질문 품질 향상용 사용자 입력 필드 2종.
 *
 * - `job_description TEXT NULL` — 사용자가 직접 붙여넣는 모집 요강 (요구 역량·우대사항 등).
 *   회사·직무만으로는 일반론적 질문에 그치지만 모집 요강이 있으면 회사 특화 키워드 기반 질문이 가능.
 * - `emphasis_points TEXT NULL` — 사용자가 면접관에게 꼭 어필하고 싶은 강점/경험.
 *   AI 가 본인 의도 방향으로 추궁 질문을 생성하도록 가이드.
 *
 * 둘 다 nullable — 기존 row 영향 없음. 사용자가 선택적으로 입력.
 */
export class AddInterviewPrepQualityFields1779980000000 implements MigrationInterface {
  name = 'AddInterviewPrepQualityFields1779980000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE interview_prep_sessions
        ADD COLUMN job_description TEXT NULL,
        ADD COLUMN emphasis_points TEXT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE interview_prep_sessions
        DROP COLUMN IF EXISTS emphasis_points,
        DROP COLUMN IF EXISTS job_description
    `);
  }
}
