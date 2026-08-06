import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 면접 질문 생성 진행 상태 (v2.1, 2026-08-07).
 *
 * ## 왜 필요한가
 *
 * 질문 생성은 ~10초 걸린다. 그 사이 새로고침하면 화면이 "아직 질문이 없어요" 로
 * 돌아가 사용자가 실패한 줄 알고 다시 누르고, in-flight lock 에 막혀 엉뚱한 문구를 본다.
 * 결과가 유실되진 않지만 **무슨 일이 일어난 건지 알 수 없다.**
 *
 * 자소서 `coverletter_generation_status` 와 같은 구조다.
 *
 * ## 안전성
 *
 * `DEFAULT 'idle'` — 기존 세션은 전부 idle 이 되고 동작이 바뀌지 않는다.
 * `generation_started_at` 은 stale 회수 기준 (조회 시점 2분 초과면 idle 간주).
 */
export class AddInterviewGenerationStatus1785500000000 implements MigrationInterface {
  name = 'AddInterviewGenerationStatus1785500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE interview_prep_sessions
         ADD COLUMN generation_status VARCHAR(20) NOT NULL DEFAULT 'idle',
         ADD COLUMN generation_started_at TIMESTAMPTZ`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE interview_prep_sessions
         DROP COLUMN IF EXISTS generation_status,
         DROP COLUMN IF EXISTS generation_started_at`,
    );
  }
}
