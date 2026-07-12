import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 공고 요건 파싱 — 재진입 진행 상태 (parsing lock).
 *
 * 파싱은 5~15초 짧은 작업이라 자소서 생성(30분 stuck cron)과 달리 별도 cron 없이
 * **읽기 시점 stale 판정**(started_at 2분 초과 = idle 간주)으로 단순화한다.
 *
 * 1. `applications.job_posting_status VARCHAR(20) NULL` — NULL=idle, 'parsing' 만 사용.
 *    (자소서의 4-state enum 과 달리 lock 용도 단일 상태. CHECK 제약 없이 서비스가 값 통제.)
 * 2. `applications.job_posting_started_at TIMESTAMPTZ NULL` — parsing 시작 시각.
 *    atomic 시작 UPDATE 의 stale 회수 조건(started_at < NOW()-2min)과 읽기 stale 판정에 사용.
 *
 * down() 은 CI 왕복 검증용 reversible — 2 컬럼 DROP.
 */
export class AddJobPostingStatus1783883672658 implements MigrationInterface {
  name = 'AddJobPostingStatus1783883672658';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD "job_posting_status" character varying(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" ADD "job_posting_started_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN "job_posting_started_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN "job_posting_status"`,
    );
  }
}
