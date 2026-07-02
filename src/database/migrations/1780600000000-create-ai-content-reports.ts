import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W2 RN — Google Play AI 콘텐츠 정책 대응.
 *
 * 사용자가 AI 생성물 (자소서 · 면접 prep · 요약 · 회사조사 등) 에서
 * 정책 위반 사례를 신고할 수 있는 창구.
 *
 * - reporter_user_id ON DELETE SET NULL — 신고자 탈퇴해도 신고 이력 보존 (audit).
 * - content_id nullable — 원본 콘텐츠가 삭제됐거나 미상일 수 있음.
 * - status default 'pending' — admin 이 처리 (별도 admin 페이지는 후속).
 * - index (status, created_at desc) — admin backlog 조회 최적화.
 */
export class CreateAiContentReports1780600000000 implements MigrationInterface {
  name = 'CreateAiContentReports1780600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ai_content_reports" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "reporter_user_id" uuid,
        "content_type" varchar(20) NOT NULL,
        "content_id" uuid,
        "reason" varchar(30) NOT NULL,
        "detail" text,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "resolved_at" TIMESTAMPTZ,
        "resolved_by" uuid,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "pk_ai_content_reports" PRIMARY KEY ("id"),
        CONSTRAINT "ck_ai_content_reports_type" CHECK (
          "content_type" IN ('coverletter','interview_answer','note_summary','company_research','other')
        ),
        CONSTRAINT "ck_ai_content_reports_reason" CHECK (
          "reason" IN ('hate_speech','misinformation','privacy_violation','harmful_content','copyright','other')
        ),
        CONSTRAINT "ck_ai_content_reports_status" CHECK (
          "status" IN ('pending','reviewed','resolved','dismissed')
        ),
        CONSTRAINT "fk_ai_content_reports_reporter" FOREIGN KEY ("reporter_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_ai_content_reports_resolver" FOREIGN KEY ("resolved_by")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_ai_content_reports_status_created"
        ON "ai_content_reports" ("status", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_ai_content_reports_status_created"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_content_reports"`);
  }
}
