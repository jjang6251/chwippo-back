import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F6 PR 1 — 자소서 답변 ↔ 활동 로그/회고 참조 테이블.
 *
 * **설계 결정** (focus.md F6 PR 1 + ADR-019·023·027):
 * - **application_coverletter 만 부착** — myinfo 자소서 소재 (CoverletterDraft) 는 raw 풀 그대로, ref 없음
 * - **source_log_id XOR source_reflection_id** — 한 row 는 둘 중 하나만 가리킴 (CHECK 제약)
 * - **CASCADE** — coverletter 삭제 → ref 자동 삭제 / activity_log·reflection 삭제 시도 → assertNoSourceRefs 가 미리 차단 (F5 hard delete 가드, 409)
 * - **PG NULL UNIQUE 동작 회피** — PostgreSQL 은 NULL 을 distinct 취급해서 단일 UNIQUE (cov, log, reflection) 로는 (cov, log=A, ref=NULL) 중복 차단 불가.
 *   partial unique index 2개로 log·reflection 각각 분리 (PG 15+ NULLS NOT DISTINCT 도 대안이지만 호환성 ↑)
 * - **partial_range JSONB** — 자소서 답변의 일부만 참조하는 경우 (예: {paragraph: 2, sentenceStart: 0, sentenceEnd: 3}). 형식은 client UI 가 결정, 백은 raw 저장
 * - **ai_recommended** — AI 가 자동 선택했는지 vs 사용자가 명시 선택했는지 추적 (PR 1 UI 의 "AI 추천 칩" 표시)
 */
export class CreateCoverletterSourceRefs1779940000000 implements MigrationInterface {
  name = 'CreateCoverletterSourceRefs1779940000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE coverletter_source_refs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        coverletter_id UUID NOT NULL REFERENCES application_coverletters(id) ON DELETE CASCADE,
        source_log_id UUID NULL REFERENCES activity_logs(id) ON DELETE CASCADE,
        source_reflection_id UUID NULL REFERENCES activity_reflections(id) ON DELETE CASCADE,
        snippet_text TEXT NULL,
        partial_range JSONB NULL,
        ai_recommended BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_csr_xor_source CHECK (
          (source_log_id IS NOT NULL AND source_reflection_id IS NULL) OR
          (source_log_id IS NULL AND source_reflection_id IS NOT NULL)
        )
      )
    `);

    // partial unique index — PG NULL UNIQUE 회피 (log·reflection 각각 분리)
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_csr_coverletter_log
        ON coverletter_source_refs (coverletter_id, source_log_id)
        WHERE source_log_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_csr_coverletter_reflection
        ON coverletter_source_refs (coverletter_id, source_reflection_id)
        WHERE source_reflection_id IS NOT NULL
    `);

    // 조회 인덱스 — assertNoSourceRefs 가드 + coverletter 본문 사이드 패널 표시
    await queryRunner.query(`
      CREATE INDEX idx_csr_coverletter ON coverletter_source_refs (coverletter_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_csr_source_log ON coverletter_source_refs (source_log_id)
        WHERE source_log_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX idx_csr_source_reflection ON coverletter_source_refs (source_reflection_id)
        WHERE source_reflection_id IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS coverletter_source_refs`);
    // index·constraint 는 DROP TABLE 시 자동 제거
  }
}
