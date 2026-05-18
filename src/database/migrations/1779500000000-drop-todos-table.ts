import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * LRR P1T3 PR I — todos 테이블 제거 (반쪽짜리 통합 마무리).
 *
 * 배경:
 * - 2026-05-09 commit fa6031d "대시보드 할 일 ↔ DailyNote 통합"에서 대시보드 TodosSection이
 *   /todos → /calendar/daily-notes로 전환. 데이터 이관은 1778200000000-migrate-todos-to-daily-notes로 완료.
 * - 그러나 todos 테이블·API·모듈은 정리 안 됨 → dead code로 잔존
 * - PR I에서 LRR Tier 3 dead code 정리하며 함께 제거
 *
 * 안전성:
 * - 프론트 전수 grep 결과 /todos API 호출 0건
 * - 데이터는 이미 daily_notes로 이관됨 (1778200000000)
 * - todos 테이블 row가 남아있을 수 있으나(이관 후 미삭제 추가분 없음 확인) 의미상 daily_notes가 권위
 *
 * down(): 비가역. 복원 필요 시 1778200000000을 revert 후 1777315557617 revert 순으로 진행하거나
 * daily_notes에서 hourSlot=null row를 todos로 역이관 수동 작성 필요.
 */
export class DropTodosTable1779500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS todos`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 스키마 복원 — 데이터는 비어있음 (1778200000000으로 daily_notes 이관 완료).
    // CI rollback 검증(down → up) + 이전 마이그레이션들의 down()이 todos 테이블 존재를 가정해
    // 정상 reversible로 작성. 실 복원이 필요한 경우 1778200000000 revert로 데이터까지 회복 가능.
    await queryRunner.query(
      `CREATE TABLE "todos" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "content" text NOT NULL,
        "date" date NOT NULL,
        "is_done" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ca8cafd59ca6faaf67995344225" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "todos" ADD CONSTRAINT "FK_todos_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE`,
    );
  }
}
