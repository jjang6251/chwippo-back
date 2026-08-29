import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `applications.posting_meta` JSONB — 공고 붙여넣기 카드의 관측·복원 메타 (2026-08-29 · 대장 21).
 *
 * ## 왜 필요한가 — 저장된 카드만 보면 「AI 가 채운 값」과 「사람이 고친 값」이 같다
 *
 * 공고로 만든 카드의 `job_title = '브랜드 마케터'` 는 AI 가 뽑은 그대로일 수도, 사용자가
 * 고친 것일 수도 있는데 **컬럼에는 똑같이 보인다**. 그러면 이 기능의 핵심 품질 지표인
 * 「AI 값 수정률」이 계산 자체가 불가능하다 — 「잘 뽑는다」와 「매번 고친다」를 못 가른다.
 *
 * ## 컬럼 하나(JSONB)인 이유
 *
 * 담을 것이 7종(`filled`·`deadlineKind`·`jobPicked`·`companySource`·`editedFields`·
 * `reviewedAt`·`callCount`)인데 **전부 이 기능에서만 쓰이고, 전부 같이 생기고 같이 사라진다**.
 * 컬럼 7개로 펼치면 다른 경로로 만든 카드 수천 행에 영원히 NULL 7개가 붙는다.
 *
 * ## 🔴 `note_ids` 만은 관측이 아니라 **동작**이다
 *
 * 공고의 발표·검진 일정은 스텝이 아니라 `daily_notes`(캘린더 메모)로 들어간다
 * (정정 11 — 「내가 하는 것은 스텝, 기다리거나 가는 날은 일정」). 그 메모들은 카드와
 * **FK 로 이어져 있지 않으므로**, 되돌리기(카드 soft delete)가 메모까지 지우려면
 * 여기 적힌 id 목록이 유일한 연결 고리다. 이 값이 없으면 카드를 지워도 캘린더에
 * 「무신사 · 서류 합격 발표」가 영영 남는다.
 *
 * ## 인덱스를 만들지 않는 이유
 *
 * 유일한 소비자는 5분 캐시가 붙은 admin 전체 스캔 집계(`/ops/card-fields`)와,
 * 카드 단건 조회(PK 로 이미 찾은 행)다. 사용자 요청 경로에서 이 컬럼으로 **검색하지 않는다**.
 * 8/25·8/27 관측 컬럼과 같은 판단.
 *
 * ## 파괴적 변경 아님
 *
 * nullable 컬럼 ADD 하나. 기존 카드는 NULL(= 공고 경로 아님)이고 백필하지 않는다.
 */
export class AddApplicationPostingMeta1787100000000 implements MigrationInterface {
  name = 'AddApplicationPostingMeta1787100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE applications
        ADD COLUMN IF NOT EXISTS posting_meta JSONB
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN applications.posting_meta IS
        '공고 붙여넣기 카드의 관측·복원 메타(filled·deadlineKind·jobPicked·companySource·editedFields·reviewedAt·callCount·textHash·noteIds·extraDates·orderConflict). NULL=공고 경로 아님. noteIds 는 되돌리기 동작에 쓰임'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE applications
        DROP COLUMN IF EXISTS posting_meta
    `);
  }
}
