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

  public down(): Promise<void> {
    return Promise.reject(
      new Error(
        'DropTodosTable1779500000000.down() is irreversible. ' +
          'todos data has been migrated to daily_notes (see 1778200000000) and the table is dead code. ' +
          'If restore is truly needed: revert 1779400000000 (FK cleanup) → recreate table manually → ' +
          'revert 1778200000000 to restore data.',
      ),
    );
  }
}
