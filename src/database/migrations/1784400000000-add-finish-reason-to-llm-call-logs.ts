import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D0 (2026-08-01 자소서 점검 크래시) — `llm_call_logs.finish_reason` 추가.
 *
 * **왜**: provider 가 `finishReason` 을 계산만 하고 버려서 **출력 잘림이 로그에 전혀 남지 않았다.**
 * 그래서 `coverletter_feedback` 의 출력 한도(1,500)가 스키마 요구량(~3,100)보다 작아 매번 잘리고
 * 있었는데도 사용자 신고 전까지 아무도 몰랐다. 이제 잘림 빈도를 데이터로 볼 수 있다.
 *
 * - `'length'` = 출력 토큰 한도 도달(잘림) · `'stop'`/`'tool_use'` = 정상 종료
 * - NULL = 이 컬럼 도입 이전 row, 또는 `blocked_*` 처럼 provider 미호출 경로
 * - **인덱스 없음** — 집계는 기존 `idx_llm_call_logs_user_feature (user_id, feature, created_at)` 로 충분하고,
 *   저카디널리티(5종) 컬럼 단독 인덱스는 이득이 없다
 * - nullable + DEFAULT 없음 → append-only 무중단. 2단계 릴리즈 불필요
 *
 * ⚠️ **`migration:generate` 를 쓰지 말 것** — 이 레포는 엔티티(`string`)와 DB(`uuid`·`timestamptz`) 사이에
 * 구조적 drift 가 있어 generate 가 509줄짜리 파괴적 diff(`user_id` DROP/ADD, `timestamptz`→`timestamp`,
 * FK·인덱스 전량 재생성)를 만든다. 이 레포의 마이그레이션은 전부 손으로 쓴다.
 */
export class AddFinishReasonToLlmCallLogs1784400000000 implements MigrationInterface {
  name = 'AddFinishReasonToLlmCallLogs1784400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE llm_call_logs ADD COLUMN finish_reason VARCHAR(20) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // reversible — CI 가 down→up 왕복을 검증한다 (throw 금지)
    await queryRunner.query(
      `ALTER TABLE llm_call_logs DROP COLUMN IF EXISTS finish_reason`,
    );
  }
}
