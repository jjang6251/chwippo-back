import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR_B1c Phase A — 회사조사 outdated 표시 컬럼.
 *
 * **목적**: status='completed' 인 application 의 회사명·직무 수정 감지.
 * 변경 시 outdated_at = NOW() 저장 → UI 가 "회사 정보 수정됨" banner 표시.
 *
 * **흐름**:
 * - update endpoint 가 companyName/jobTitle/jobCategory 변경 감지 시 outdated_at = NOW()
 * - generateCoverletter 가 outdated_at not null → atomic WHERE 통과 (재진행 허용)
 * - 재조사 완료 시 outdated_at NULL reset
 *
 * **변경 영향 없는 필드**: memo, status, currentStepIndex, isStarred, steps[] 등
 */
export class AddCoverletterResearchOutdated1780300000000 implements MigrationInterface {
  name = 'AddCoverletterResearchOutdated1780300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE applications
      ADD COLUMN coverletter_research_outdated_at TIMESTAMPTZ
    `);
    // 부분 인덱스 — outdated 인 row 만 조회 (cron 또는 UI 갱신 시 빠른 lookup)
    await queryRunner.query(`
      CREATE INDEX idx_applications_coverletter_research_outdated
      ON applications(coverletter_research_outdated_at)
      WHERE coverletter_research_outdated_at IS NOT NULL
    `);

    // PR_B1c CTO 검토 M3 — legacy backfill 의 silent 50 코인 차감 차단:
    //   1780200000000 마이그레이션이 자소서 row 있는 application 들을 status='completed' 로 backfill.
    //   단 그 시점에 회사조사 cache 가 실제로 없음 (잘못된 가정).
    //   사용자가 자소서 페이지 진입 시 자동 fetchResearch → 50 코인 silent 차감 (정책 위반).
    //   → outdated_at = NOW() 표시. UI 가 OutdatedBanner 노출 + 사용자 명시 "다시 조사" 동의 modal.
    //   이미 cache 가진 application 은 outdated_at 표시돼도 자소서 chat 가능 (banner 만 노출).
    await queryRunner.query(`
      UPDATE applications
      SET coverletter_research_outdated_at = NOW()
      WHERE coverletter_generation_status = 'completed'
        AND id IN (
          SELECT DISTINCT application_id
          FROM application_coverletters
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_applications_coverletter_research_outdated`,
    );
    await queryRunner.query(`
      ALTER TABLE applications DROP COLUMN IF EXISTS coverletter_research_outdated_at
    `);
  }
}
