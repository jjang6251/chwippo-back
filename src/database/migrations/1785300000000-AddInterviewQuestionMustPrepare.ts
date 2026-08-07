import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 면접 질문 **우선 준비 표시** 컬럼 (v2.1, 2026-08-07).
 *
 * ## 왜 필요한가
 *
 * 조사 실측 — 신입 면접은 1인 평균 26분이고 1분 자기소개를 빼면 실질 문답이 4분 남짓,
 * **실제로 받는 질문은 5개 안팎**이다. 그런데 세션은 20~22문항을 만든다.
 * 다 준비하라는 건 현실과 맞지 않아서, 모델이 "먼저 준비할 것" 5~7개를 골라 표시한다.
 *
 * ## 안전성
 *
 * `NOT NULL DEFAULT false` — 기존 행은 전부 false 가 되고, 화면은 표시가 없을 뿐
 * 그대로 동작한다. 파괴적 변경이 아니라 2단계 릴리즈 대상이 아니다.
 */
export class AddInterviewQuestionMustPrepare1785300000000 implements MigrationInterface {
  name = 'AddInterviewQuestionMustPrepare1785300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE interview_prep_questions
         ADD COLUMN must_prepare BOOLEAN NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // reversible — CI 가 down→up 왕복을 검증한다
    await queryRunner.query(
      `ALTER TABLE interview_prep_questions DROP COLUMN IF EXISTS must_prepare`,
    );
  }
}
