import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F6 PR 2 Phase 2 — 면접 준비 세션 + 질문 (재귀 트리, depth 0~2).
 *
 * **설계 결정** (focus.md F6 PR 2 + ADR-023·024):
 * - **interview_prep_sessions** — 한 application 의 round/면접 종류 별 세션. coverletter_ids/extra_log_ids JSONB 로 selected refs 보관 (생성 시점 snapshot)
 *   - `coverletter_ids JSONB` — 사용자가 선택한 자소서 문항 id (`application_coverletters.id`). 빈 배열 가능
 *   - `extra_log_ids JSONB` — 자소서 외 추가로 선택한 activity_log id. F5 hard delete 가드 JSONB `@>` 로 차단
 * - **interview_prep_questions** — self-ref 트리. depth 0=main, 1=follow-up, 2=follow-up of follow-up (3+ 차단 — CHECK)
 *   - `parent_question_id UUID NULL` — depth 0 면 NULL
 *   - `source_log_ids JSONB` — AI 가 답변 작성 시 참조한 activity_log id. F5 hard delete 가드 JSONB `@>` 로 차단
 *   - `suggested_answer TEXT` — AI 가 생성한 모범 답안 (사용자 my_memo 와 분리 — my_memo 는 사용자가 직접 작성)
 *   - `my_memo TEXT NULL` — 사용자의 본인 답변 메모 (autosave 대상)
 * - **CASCADE** — application 삭제 → session 삭제 → question 삭제. parent_question 삭제 → child question 삭제
 * - **GIN 인덱스** — F5 hard delete 가드의 JSONB `@>` 쿼리 성능. activity_log 삭제 시도 시 모든 session/question 의 array containment 검색 ≤10ms
 * - **응답 DTO user_id strip** (Q4) — defense in depth, F6.5 익명화 준비. 백엔드는 user_id 저장만, 응답 직전 mapper 가 제거
 *
 * **관계 메모**:
 * - session.user_id 는 IDOR 가드용 (application.user_id 와 같지만 JOIN 회피)
 * - question.session_id 만 보유 — application·user 는 session 통해 traverse
 */
export class CreateInterviewPrep1779970000000 implements MigrationInterface {
  name = 'CreateInterviewPrep1779970000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE interview_prep_sessions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        round VARCHAR(40) NOT NULL,
        interview_type VARCHAR(40) NULL,
        coverletter_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        extra_log_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        my_memo TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_ips_user ON interview_prep_sessions (user_id, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_ips_application ON interview_prep_sessions (application_id, created_at DESC)
    `);
    // F5 hard delete 가드 — activity_log 삭제 시 extra_log_ids @> '[logId]' 검색
    await queryRunner.query(`
      CREATE INDEX idx_ips_extra_log_ids_gin ON interview_prep_sessions USING GIN (extra_log_ids)
    `);

    await queryRunner.query(`
      CREATE TABLE interview_prep_questions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        session_id UUID NOT NULL REFERENCES interview_prep_sessions(id) ON DELETE CASCADE,
        parent_question_id UUID NULL REFERENCES interview_prep_questions(id) ON DELETE CASCADE,
        depth SMALLINT NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 2),
        order_index INT NOT NULL DEFAULT 0,
        question_text TEXT NOT NULL,
        suggested_answer TEXT NULL,
        source_log_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        my_memo TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_ipq_session ON interview_prep_questions (session_id, order_index)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_ipq_parent ON interview_prep_questions (parent_question_id) WHERE parent_question_id IS NOT NULL
    `);
    // F5 hard delete 가드 — activity_log 삭제 시 source_log_ids @> '[logId]' 검색
    await queryRunner.query(`
      CREATE INDEX idx_ipq_source_log_ids_gin ON interview_prep_questions USING GIN (source_log_ids)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS interview_prep_questions`);
    await queryRunner.query(`DROP TABLE IF EXISTS interview_prep_sessions`);
  }
}
