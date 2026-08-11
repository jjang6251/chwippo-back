import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 준비 노트 **다중 시트** 테이블 (2026-08-11).
 *
 * ## 왜
 *
 * 스텝 하나에 노트가 **한 장**뿐이라, 사용자는 자소서 초안·면접 예상질문·회사 조사를
 * 한 문서에 이어 붙이고 있었다. 실사용자 요청은 "엑셀 탭처럼 나누고 싶다" 였다.
 *
 * ## 🔴 기존 노트는 건드리지 않는다
 *
 * `application_steps.notes` 는 **읽기 전용 유산**으로 남는다. 이 마이그레이션은
 * 컬럼을 지우지도, 데이터를 옮기지도 않는다 (backfill INSERT 도 없다).
 * 승격(기존 노트 → 첫 시트)은 사용자가 그 스텝을 열었을 때 프론트가
 * `POST .../note-sheets { ifEmpty: true }` 로 만드는 **런타임 경로**다.
 * 이유는 둘이다 — (1) 대량 backfill 은 tiptap JSON 을 서버가 해석해야 하는데
 * 실패해도 알 방법이 없고, (2) 원본이 그대로 남아 있어야 되돌릴 자리가 있다.
 * 그래서 이 릴리즈는 파괴적 변경이 아니고 2단계 릴리즈 대상도 아니다.
 *
 * ## 설계
 *
 * | 결정 | 이유 |
 * |---|---|
 * | `step_id ... ON DELETE CASCADE` | `step_checklist_items` 와 같은 규칙 — 스텝이 사라지면 시트도 사라진다 |
 * | `name VARCHAR(50)` | 탭 라벨. 길이 판정(trim 후 1~50)은 서비스가, 컬럼은 최종 방어선 |
 * | `content TEXT NULL` | tiptap doc JSON 문자열. 빈 시트 = NULL |
 * | `INDEX (step_id, order_index)` | 유일한 조회 패턴이 "이 스텝의 시트를 순서대로" 하나뿐 |
 *
 * 시트 장수 상한(10)·마지막 1장 삭제 금지는 CHECK 로 표현할 수 없는 집합 제약이라
 * 서비스가 **스텝 행을 잠그고** 판정한다.
 */
export class CreateStepNoteSheets1785800000000 implements MigrationInterface {
  name = 'CreateStepNoteSheets1785800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE step_note_sheets (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        step_id UUID NOT NULL REFERENCES application_steps(id) ON DELETE CASCADE,
        name VARCHAR(50) NOT NULL,
        content TEXT NULL,
        order_index INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_sns_step_order ON step_note_sheets (step_id, order_index)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // reversible — CI 가 down→up 왕복을 검증한다. index 는 DROP TABLE 시 자동 제거.
    await queryRunner.query(`DROP TABLE IF EXISTS step_note_sheets`);
  }
}
