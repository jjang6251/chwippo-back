import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 면접 **질문 은행** 컬럼 3종 (2026-08-11).
 *
 * ## 왜
 *
 * 지금까지 면접 질문은 **AI 가 만든 것뿐**이었다. 실사용자 신호는 반대였다 —
 * "AI 질문은 GPT 로도 되는데, 내가 실제로 받은 기출을 넣고 시험 보듯 연습하고 싶다."
 * 세션의 중심을 「내가 모은 질문」으로 반전시키려면 두 가지가 필요하다:
 * 출처를 가르는 값과, 연습 결과를 기억하는 자리.
 *
 * | 컬럼 | 무엇을 가능하게 하나 |
 * |---|---|
 * | `source` | 「내 질문」 배지 · 텍스트/카테고리 수정권 · 직접 꼬리를 달 수 있는 트리 · 출처 필터 |
 * | `last_practiced_at` | 연습 이력 표시 (서버 시각만) |
 * | `last_practice_result` | 시험 설정의 「다시 볼 것만」 = `'again'` |
 *
 * ## 안전성 — 비파괴 · 기존 행 자연 백필
 *
 * `source` 는 `NOT NULL DEFAULT 'ai'`. **이미 저장된 질문은 전부 AI 가 만든 것**이라
 * 기본값이 곧 정확한 백필이고, 별도 UPDATE 문이 필요 없다. 나머지 둘은 NULL 허용
 * (= 아직 연습 안 함). 컬럼 추가만 하므로 2단계 릴리즈 대상이 아니다.
 *
 * ## 왜 CHECK 제약이 없나
 *
 * `interview_type`·`category` 와 같은 판단이다 — 값 추가가 마이그레이션을 부르지 않게 한다.
 * 실제 강제는 DTO 화이트리스트(`'ai'|'user'`, `'good'|'soso'|'again'`)가 한다.
 *
 * 신규 인덱스도 없다. 두 값은 **세션 스코프 안에서만** 조회되고
 * (`WHERE session_id = ?`), 세션당 행이 수십 개라 기존 `idx_ipq_session` 으로 충분하다.
 */
export class AddInterviewQuestionBankColumns1785700000000 implements MigrationInterface {
  name = 'AddInterviewQuestionBankColumns1785700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE interview_prep_questions
         ADD COLUMN source VARCHAR(10) NOT NULL DEFAULT 'ai'`,
    );
    await queryRunner.query(
      `ALTER TABLE interview_prep_questions
         ADD COLUMN last_practiced_at TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE interview_prep_questions
         ADD COLUMN last_practice_result VARCHAR(10)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // reversible — CI 가 down→up 왕복을 검증한다
    await queryRunner.query(
      `ALTER TABLE interview_prep_questions DROP COLUMN IF EXISTS last_practice_result`,
    );
    await queryRunner.query(
      `ALTER TABLE interview_prep_questions DROP COLUMN IF EXISTS last_practiced_at`,
    );
    await queryRunner.query(
      `ALTER TABLE interview_prep_questions DROP COLUMN IF EXISTS source`,
    );
  }
}
