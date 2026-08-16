import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 면접 유도 모달 (2026-08-16) — 컬럼 3개.
 *
 * ## 왜
 *
 * 면접 스텝 상세에는 이미 「이 내용으로 면접 질문 만들기」 버튼이 있는데 **두 겹으로 닫혀 있었다** —
 * 준비 노트가 비면 `disabled` 라 **처음 온 사람은 누를 수 없고**, 「준비 노트」 섹션 안이라 눈에도 안 띈다.
 * 그래서 이 기능의 일은 「없는 기능 추가」가 아니라 **있는 문을 여는 것**이다.
 * 보드에서 면접 단계로 이동하는 순간 안내 모달을 띄운다.
 *
 * ## 컬럼 3개
 *
 * | 컬럼 | 왜 여기 |
 * |---|---|
 * | `application_steps.interview_nudge_shown_at` | 노출은 **스텝당 1회**다. 1차 면접에서 닫았어도 2차 면접 단계가 되면 다시 물어야 한다 — 차수마다 준비가 새로 필요하기 때문. `applications` 에 두면 카드당 1회가 되어 2차를 놓친다 |
 * | `users.interview_nudge_dismissed_at` | 「다시 보지 않기」는 **전역 영구**다. 기존 `sample_cards_dismissed_at`·`calendar_home_intro_dismissed_at` 과 같은 자리·같은 타입 |
 * | `interview_prep_sessions.step_id` | 아래 별도 설명 |
 *
 * ## 🔴 `step_id` — 세션↔스텝을 **처음으로** 실제 연결한다
 *
 * 지금까지 세션은 `application_id` 에만 묶여 있었고, 생성 모달 드롭다운이 스텝 목록을 보여주면서도
 * 저장한 건 `value={s.name}` — **이름 문자열 복사**였다 (`CreateSessionDto` 에 `stepId` 없음).
 * 그래서 ① 스텝 이름을 고치면 세션 `round` 가 옛 이름 그대로 남고
 * ② **「이 스텝의 세션이 있나?」를 물을 수 없었다** (이름 매칭뿐이고 「직접 입력」 값과 섞인다).
 *
 * ②가 이번 기능의 핵심 판정이라 FK 로 승격했다 — 1차 세션이 있어도 2차 단계에선 뜨고,
 * 그 스텝의 세션이 이미 있으면 안 뜬다.
 *
 * - **`ON DELETE SET NULL`** — 스텝을 지워도 **세션은 남긴다.** 코인을 써서 만든 질문이고
 *   `round` 문자열이 남아 의미를 유지한다. `CASCADE` 였다면 스텝 정리가 세션 삭제로 번진다
 * - **인덱스를 같이 만든다** — Postgres 는 FK 에 인덱스를 **자동 생성하지 않는다.**
 *   없으면 스텝 삭제마다 참조 검사가 full scan 이다
 * - **백필하지 않는다** — 이름 매칭은 동명 스텝·「직접 입력」 값에서 틀린다. 기존 세션은 `NULL` 로 두고
 *   신규부터 연결한다. 대가는 「구 세션만 있는 카드에 넛지가 한 번 더 뜬다」 하나이고,
 *   「다시 보지 않기」로 닫힌다
 *
 * 셋 다 **nullable 추가**라 파괴적 변경이 아니다 → 2단계 릴리즈 불필요.
 */
export class AddInterviewNudge1786100000000 implements MigrationInterface {
  name = 'AddInterviewNudge1786100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "application_steps" ADD COLUMN "interview_nudge_shown_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "interview_nudge_dismissed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "interview_prep_sessions" ADD COLUMN "step_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "interview_prep_sessions"
         ADD CONSTRAINT "FK_interview_prep_sessions_step"
         FOREIGN KEY ("step_id") REFERENCES "application_steps"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_interview_prep_sessions_step_id"
         ON "interview_prep_sessions" ("step_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // reversible — CI 가 down→up 왕복을 검증한다.
    // 되돌리면 넛지가 꺼지고 세션↔스텝 연결이 사라질 뿐, 세션·질문 데이터는 그대로다.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_interview_prep_sessions_step_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "interview_prep_sessions"
         DROP CONSTRAINT IF EXISTS "FK_interview_prep_sessions_step"`,
    );
    await queryRunner.query(
      `ALTER TABLE "interview_prep_sessions" DROP COLUMN IF EXISTS "step_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "interview_nudge_dismissed_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "application_steps" DROP COLUMN IF EXISTS "interview_nudge_shown_at"`,
    );
  }
}
