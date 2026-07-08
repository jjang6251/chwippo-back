import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 유저 트리거 회사 조사 제거 (2026-07-09, CEO 결정 — ADR-040 예정).
 *
 * 조사 데이터 공급을 pre-seed 단일 소스로 전환하면서, 과거 유저가 트리거한
 * 조사 캐시 행을 정리한다:
 * - 삭제: seed_version IS NULL (유저 조사 행 — generic·직군 맞춤 모두).
 *   구식 스키마(8항목)가 신식 pre-seed(12항목)를 조회 우선순위에서 가리는 문제 해소.
 * - 보존: opt_out = TRUE (회사 측 삭제 요청 기록 — 법적 장치, 재수집 차단용)
 * - 보존: seed_version IS NOT NULL (pre-seed 행)
 *
 * down(): 데이터 삭제는 복원 불가 — 스키마 변경이 없으므로 no-op.
 * (CI down→up 검증은 스키마 기준으로 통과)
 */
export class RemoveUserResearchCache1780710000000 implements MigrationInterface {
  name = 'RemoveUserResearchCache1780710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "company_research_cache"
       WHERE "seed_version" IS NULL AND "opt_out" = FALSE`,
    );
  }

  public async down(): Promise<void> {
    // 데이터 삭제 마이그레이션 — 복원 대상 없음 (스키마 무변경, no-op)
  }
}
