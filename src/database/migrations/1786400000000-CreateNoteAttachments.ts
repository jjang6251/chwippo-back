import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * **공부 노트 첨부** 테이블 (2026-08-20 · 미디어 아크 PR-A).
 *
 * ## 왜 전용 테이블인가
 *
 * myinfo 증빙 파일은 항목 하나에 파일 하나라 인라인 컬럼으로 충분했다. 노트 본문은
 * 한 문서에 여러 장이 들어가고, 저장할 때마다 "본문이 아직 가리키는가" 를 되물어야
 * 하므로(reconcile) 행 단위로 존재해야 한다.
 *
 * ## 설계
 *
 * | 결정 | 이유 |
 * |---|---|
 * | `user_id ... CASCADE` | 탈퇴 = 전부 삭제. 동시에 용량 합산·탈퇴 R2 정리가 노트를 조인하지 않고 사용자로 바로 묶인다 |
 * | `note_id ... CASCADE` | 노트를 지우면 행도 사라진다. R2 객체는 코드가 삭제 전에 URL 을 모아 best-effort 로 지운다 (DB 가 지운 뒤엔 무엇을 지울지 알 수 없다) |
 * | `file_url` **UNIQUE** | 등록 재시도 멱등. R2 PUT 은 성공했는데 등록 응답을 못 받은 프론트가 같은 URL 로 다시 불러도 행은 하나다 (서비스가 기존 행을 그대로 돌려준다) |
 * | `file_size_bytes BIGINT NOT NULL` | 100MB 풀 합산의 재료. myinfo 와 같은 타입이라 `BigIntTransformer` 규약을 그대로 쓴다 |
 * | `strokes_url`·`strokes_size_bytes` NULL | 필기(PR-C 보류) 예약. 지금은 항상 NULL 이지만 컬럼을 먼저 세워 두면 용량 합산 코드가 처음부터 두 값을 더한다 — 나중에 더하기를 빠뜨리는 쪽이 훨씬 비싸다 |
 * | `kind` VARCHAR + CHECK | 이 스키마에 PG enum 타입은 하나도 없다. 값이 늘 때 `ALTER TYPE` 대신 CHECK 교체로 끝난다 (`study_note_links.from_type` 과 같은 규약) |
 * | idx(note_id) · idx(user_id) | 조회 패턴이 둘뿐이다 — "이 노트의 첨부"(reconcile·삭제) 와 "이 사용자의 총 용량"(cap·탈퇴) |
 *
 * ## 파괴적 변경 아님
 *
 * 기존 테이블·컬럼을 하나도 건드리지 않는다 (생성만). down 은 `DROP TABLE` 하나로
 * 완전히 되돌아간다 (인덱스·FK·CHECK·UNIQUE 는 같이 사라진다).
 */
export class CreateNoteAttachments1786400000000 implements MigrationInterface {
  name = 'CreateNoteAttachments1786400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE note_attachments (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        note_id UUID NOT NULL REFERENCES study_notes(id) ON DELETE CASCADE,
        kind VARCHAR(16) NOT NULL,
        file_url VARCHAR NOT NULL UNIQUE,
        file_size_bytes BIGINT NOT NULL,
        strokes_url VARCHAR NULL,
        strokes_size_bytes BIGINT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_na_kind CHECK (kind IN ('image', 'drawing'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_na_note ON note_attachments (note_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_na_user ON note_attachments (user_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // reversible — CI 가 down→up 왕복을 검증한다.
    // 인덱스·FK·CHECK·UNIQUE 는 DROP TABLE 시 같이 사라진다.
    await queryRunner.query(`DROP TABLE IF EXISTS note_attachments`);
  }
}
