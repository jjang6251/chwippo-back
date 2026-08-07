import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 꼬리질문 근거 컬럼 (v2.1, 2026-08-07).
 *
 * 꼬리질문은 세 갈래로 만들어진다 — 내가 쓴 메모 추궁 / AI 답변 추궁 / 질문 심화.
 * 실제 면접의 꼬리질문은 거의 전부 앞의 둘("내가 한 말" 을 파고드는 것)이고,
 * 세 번째는 답변이 아직 없을 때의 폴백이라 성격이 다르다.
 *
 * 화면이 이걸 구분해 보여줘야 사용자가 **"메모를 먼저 쓰는"** 순서를 알게 된다.
 * 기존 행은 NULL — 옛 꼬리질문은 배지 없이 그대로 보인다.
 */
export class AddFollowupBasis1785400000000 implements MigrationInterface {
  name = 'AddFollowupBasis1785400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE interview_prep_questions
         ADD COLUMN followup_basis VARCHAR(20)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE interview_prep_questions DROP COLUMN IF EXISTS followup_basis`,
    );
  }
}
