import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI 답변의 **자료 부족 사유** 컬럼 (2026-08-07).
 *
 * ## 왜 컬럼을 만드나 — 프롬프트로 두 번 실패했다
 *
 * 답변 본문(`suggested_answer`)은 사용자가 **면접장에서 그대로 말할 1인칭 발화**다.
 * 그런데 모델은 "자료가 부족하다" 를 계속 그 본문 안에서 말하려 했고, 금지할 때마다
 * 형태만 바꿔 나왔다:
 *
 * 1. `[본인 경험 채우기]` 대괄호 자리표시자 → 금지
 * 2. `"~를 더하면 설득력이 커집니다"` 3인칭 코치 문장 → 금지
 * 3. `"자료상 명확한 실패 사례가 있었던 것은 아니지만"` — "자료" 는 앱 내부를 가리키는
 *    말이라 면접관이 알 수 없다. 그대로 외워 말하면 즉사한다
 *
 * 세 형태는 **같은 일**을 하고 있었다. 모델이 규칙을 어긴 게 아니라, 그 정보를 내보낼
 * **출구가 답변 본문밖에 없었다.** 네 번째 금지 문장을 쓰는 대신 출구를 따로 낸다.
 *
 * ## 왜 boolean + hint 가 아니라 컬럼 하나인가
 *
 * `NULL` = 자료 충분, 값 있음 = 부족 + 그 사유. boolean 을 따로 두면 두 값이 어긋날 수
 * 있고(`true` 인데 hint 가 비었거나 그 반대), 화면 분기도 두 번 봐야 한다.
 *
 * 기존 행은 NULL — 옛 답변은 배지 없이 그대로 보인다.
 */
export class AddAnswerMaterialGap1785600000000 implements MigrationInterface {
  name = 'AddAnswerMaterialGap1785600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE interview_prep_questions
         ADD COLUMN material_gap TEXT`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // reversible — CI 가 down→up 왕복을 검증한다
    await queryRunner.query(
      `ALTER TABLE interview_prep_questions DROP COLUMN IF EXISTS material_gap`,
    );
  }
}
