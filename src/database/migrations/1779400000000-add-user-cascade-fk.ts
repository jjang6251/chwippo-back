import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * User 탈퇴 시 자식 데이터 cascade 삭제.
 *
 * 배경: 기존엔 users row만 삭제되고 자식 테이블(myinfo·application·todo 등) row가 orphan으로 남아
 * 어드민 글로벌 사용량 SUM에 그대로 포함되는 정합성 문제 발견.
 *
 * 변경:
 * 1. myinfo_documents.user_id 타입을 varchar → uuid (1777400000000 마이그레이션에서 누락된 테이블)
 * 2. 11개 테이블의 orphan rows 정리 (FK 추가 전 필수)
 * 3. 11개 테이블에 ON DELETE CASCADE FK 추가
 *
 * down(): FK 제거 + user_id 타입 복원. 단 orphan 정리는 비가역 (백업 없이 복원 불가).
 */
export class AddUserCascadeFk1779400000000 implements MigrationInterface {
  /** FK CASCADE를 추가할 대상 (이미 CASCADE 있는 daily_notes·myinfo_educations·myinfo_exam_schedules 제외) */
  private readonly TARGETS: { table: string; fkName: string }[] = [
    { table: 'applications', fkName: 'FK_applications_user' },
    { table: 'inquiries', fkName: 'FK_inquiries_user' },
    { table: 'todos', fkName: 'FK_todos_user' },
    { table: 'user_profiles', fkName: 'FK_user_profiles_user' },
    { table: 'myinfo_certs', fkName: 'FK_myinfo_certs_user' },
    { table: 'myinfo_awards', fkName: 'FK_myinfo_awards_user' },
    { table: 'myinfo_language_certs', fkName: 'FK_myinfo_language_certs_user' },
    { table: 'myinfo_documents', fkName: 'FK_myinfo_documents_user' },
    { table: 'myinfo_experiences', fkName: 'FK_myinfo_experiences_user' },
    { table: 'myinfo_coverletter', fkName: 'FK_myinfo_coverletter_user' },
    {
      table: 'myinfo_coverletter_custom',
      fkName: 'FK_myinfo_coverletter_custom_user',
    },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. myinfo_documents user_id 타입 통일 (varchar → uuid)
    //    먼저 orphan을 지워야 캐스팅 실패 안 함 (NULL 또는 잘못된 uuid)
    await queryRunner.query(
      `DELETE FROM "myinfo_documents" WHERE "user_id" IS NULL OR "user_id"::text NOT IN (SELECT id::text FROM users)`,
    );
    await queryRunner.query(
      `ALTER TABLE "myinfo_documents" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid`,
    );

    // 2. 나머지 테이블 orphan rows 정리
    for (const { table } of this.TARGETS) {
      if (table === 'myinfo_documents') continue; // 위에서 처리
      await queryRunner.query(
        `DELETE FROM "${table}" WHERE "user_id" IS NOT NULL AND "user_id" NOT IN (SELECT id FROM users)`,
      );
    }

    // 3. FK 추가 (ON DELETE CASCADE)
    for (const { table, fkName } of this.TARGETS) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${fkName}" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // FK 제거 (orphan 정리는 비가역 — 복원 불가)
    for (const { table, fkName } of this.TARGETS) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${fkName}"`,
      );
    }

    // myinfo_documents user_id를 varchar로 되돌림
    await queryRunner.query(
      `ALTER TABLE "myinfo_documents" ALTER COLUMN "user_id" TYPE character varying USING "user_id"::text`,
    );
  }
}
