import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * **공부 노트** 테이블 3종 (2026-08-18).
 *
 * ## 왜
 *
 * 준비 노트는 지원 카드에 매여 있다. CS 정리·기출·오답 노트처럼 **회사와 무관한**
 * 공부는 지금 노션에서 하고 있고, 그만큼이 이탈 표면이다. 노션식 자유도 경쟁이
 * 아니라 "취준 흐름에 붙은 공부" 를 목표로 3개 테이블만 세운다.
 *
 * ## 설계
 *
 * | 결정 | 이유 |
 * |---|---|
 * | `study_notes.user_id ... CASCADE` | 탈퇴 = 전부 삭제 (다른 사용자 데이터와 같은 규칙) |
 * | `study_notes.folder_id ... **SET NULL**` | 폴더를 지워도 노트는 「미분류」로 남는다. 노트는 사용자가 쓴 원본이라 폴더 정리의 부수효과로 사라지면 안 된다 |
 * | `title VARCHAR(100) DEFAULT ''` | **빈 제목이 정상 값**. 생성이 노션식(버튼 → 빈 노트 → 에디터)이라 NOT NULL + 빈 문자열 허용이 그 흐름과 맞는다 |
 * | `content TEXT NULL` | tiptap doc JSON 문자열. 100,000자 상한은 DTO 가 본다 (컬럼은 최종 방어선) |
 * | `INDEX (user_id, updated_at DESC)` | 허브의 유일한 조회 패턴이 "내 노트를 최근 수정순으로" 하나뿐 |
 * | `study_note_folders.parent_id ... SET NULL` | 1차는 중첩 없음(1단 제약은 서비스가 판정). 컬럼은 2차 예약이고, 부모가 사라지면 자식은 최상위로 올라온다 |
 * | `study_note_links` 복합 PK | 같은 문서에서 같은 노트를 여러 번 멘션해도 링크는 한 줄 = 백링크 목록에 중복이 안 뜬다 |
 * | `from_type` = VARCHAR + CHECK | 이 스키마에 PG enum 타입은 하나도 없다. 값이 늘 때 `ALTER TYPE` 대신 CHECK 교체로 끝나고, down 도 테이블만 지우면 된다 |
 * | `from_id` 에 FK 없음 | **다형성** — `from_type` 에 따라 `study_notes` 이기도 `step_note_sheets` 이기도 하다. 한 컬럼이 두 테이블을 가리키는 FK 는 만들 수 없어, 출처가 사라진 링크는 조회 시 INNER JOIN 으로 걸러낸다 |
 *
 * ## 파괴적 변경 아님
 *
 * 기존 테이블·컬럼을 하나도 건드리지 않는다 (생성만). 2단계 릴리즈 대상이 아니고,
 * down 은 `DROP TABLE` 3개로 완전히 되돌아간다 (인덱스·FK 는 같이 사라진다).
 */
export class CreateStudyNotes1786200000000 implements MigrationInterface {
  name = 'CreateStudyNotes1786200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE study_note_folders (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(50) NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        parent_id UUID NULL REFERENCES study_note_folders(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_snf_user ON study_note_folders (user_id)
    `);

    await queryRunner.query(`
      CREATE TABLE study_notes (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        folder_id UUID NULL REFERENCES study_note_folders(id) ON DELETE SET NULL,
        title VARCHAR(100) NOT NULL DEFAULT '',
        content TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_sn_user_updated ON study_notes (user_id, updated_at DESC)
    `);

    await queryRunner.query(`
      CREATE TABLE study_note_links (
        from_id UUID NOT NULL,
        from_type VARCHAR(16) NOT NULL,
        to_note_id UUID NOT NULL REFERENCES study_notes(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (from_id, from_type, to_note_id),
        CONSTRAINT chk_snl_from_type CHECK (from_type IN ('study', 'prep_sheet'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_snl_to_note ON study_note_links (to_note_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // reversible — CI 가 down→up 왕복을 검증한다. 인덱스·FK·CHECK 는 DROP TABLE 시 같이 사라진다.
    // 순서 주의: 링크 → 노트 → 폴더 (FK 참조 방향의 역순)
    await queryRunner.query(`DROP TABLE IF EXISTS study_note_links`);
    await queryRunner.query(`DROP TABLE IF EXISTS study_notes`);
    await queryRunner.query(`DROP TABLE IF EXISTS study_note_folders`);
  }
}
