import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `application_steps.date_hint` — 날짜로 확정할 수 없는 일정 표현 (2026-08-29 · 대장 21).
 *
 * ## 왜 컬럼이 필요한가 — 「9월 초」를 09-01 로 적으면 두 번 잘못된다
 *
 * 공고의 전형 일정은 절반이 「9월 초」·「추후 공지」·「합격자에 한해 개별 안내」다.
 * 이걸 날짜 컬럼에 밀어 넣으면 ① 임박 알림이 **엉뚱한 날** 발송되고 ② 그 날짜가
 * 추측값이라는 사실을 사용자가 알 방법이 없다 (「사람 말만 볼펜」 위반).
 *
 * 버리는 것도 답이 아니다 — 공고엔 분명히 적혀 있었고, 사용자는 그 표현을 보고
 * 「10월쯤 다시 확인해야겠다」를 안다. **날짜가 아닌 정보는 글자로 남긴다.**
 *
 * ## 길이 40 인 이유
 *
 * 원문 그대로 짧게만 옮긴다 (「합격자에 한해 개별 안내」 = 14자). 40자를 넘는 건
 * 힌트가 아니라 문단이라 화면 한 줄에 안 들어가고, 파서가 다른 단계의 설명을
 * 끌어온 경우가 대부분이다. 서버가 40자에서 자른다.
 *
 * ## 파괴적 변경 아님
 *
 * nullable 컬럼 ADD 하나. 기존 스텝은 전부 NULL(= 힌트 없음)이고 백필하지 않는다.
 * 롤백해도 스텝 날짜·이름은 그대로라 기능 무영향 → 2단계 릴리즈 대상 아님.
 */
export class AddApplicationStepDateHint1787000000000 implements MigrationInterface {
  name = 'AddApplicationStepDateHint1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE application_steps
        ADD COLUMN IF NOT EXISTS date_hint VARCHAR(40)
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN application_steps.date_hint IS
        '날짜로 확정할 수 없는 일정 표현(9월 초·추후 공지). 원문 그대로 ≤40자 · scheduled_date 가 세팅되면 NULL'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE application_steps
        DROP COLUMN IF EXISTS date_hint
    `);
  }
}
