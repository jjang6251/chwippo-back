import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A8 Activation 측정 — 일별 방문 기록 (B안, 2026-07-06 CEO 승인).
 *
 * users.last_active_at 은 최신 방문일 하나만 남아 코호트 리텐션(D7·D30)과
 * 과거 일별 DAU 를 못 잰다 → 최소 스키마의 일별 방문 테이블 신설.
 *
 * - insert 지점: jwt.strategy 의 기존 "KST 오늘 첫 요청" 분기 (추가 write 비용 0)
 * - PK(user_id, visit_date) → ON CONFLICT DO NOTHING 멱등
 * - INDEX (visit_date) → 일별 DAU 집계
 * - ON DELETE CASCADE — 탈퇴 시 자동 정리
 * - 데이터는 배포일부터 축적 (과거 소급 불가)
 */
export class CreateUserDailyVisits1780640000000 implements MigrationInterface {
  name = 'CreateUserDailyVisits1780640000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "user_daily_visits" (
        "user_id" uuid NOT NULL,
        "visit_date" date NOT NULL,
        CONSTRAINT "pk_user_daily_visits" PRIMARY KEY ("user_id", "visit_date"),
        CONSTRAINT "fk_user_daily_visits_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_user_daily_visits_date" ON "user_daily_visits" ("visit_date")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "user_daily_visits"`);
  }
}
