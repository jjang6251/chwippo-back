import {
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { StudyNote } from './study-note.entity';

/** 멘션을 담고 있는 쪽(from)의 종류 — 공부 노트 본문 / 카드 안 준비 노트 시트 */
export type StudyNoteLinkFromType = 'study' | 'prep_sheet';

/**
 * 멘션 링크 — "**어느 문서가** 이 공부 노트를 가리키는가".
 *
 * 백링크 패널(`GET /study-notes/:id/backlinks`)의 유일한 원천이고,
 * 저장할 때마다 **from 단위로 통째 재계산**(delete + insert)된다.
 * 증분 갱신을 안 하는 이유는 본문에서 멘션이 사라진 경우를 놓치지 않기 위해서다.
 *
 * ## 왜 from 쪽에 FK 가 없나
 *
 * `from_id` 는 **다형성**이다 — `from_type` 에 따라 `study_notes` 이기도 하고
 * `step_note_sheets` 이기도 하다. 한 컬럼에 두 테이블을 가리키는 FK 는 만들 수 없다.
 * 대신:
 *  - `to_note_id` 는 진짜 FK **CASCADE** — 가리켜진 노트가 삭제되면 링크도 사라진다
 *    (끊긴 링크는 본문 칩으로만 남고 백링크 목록에는 안 남는다)
 *  - from 쪽이 사라진 경우는 백링크 조회가 **INNER JOIN** 이라 결과에서 자동으로 빠진다
 *    (공부 노트 삭제 시엔 서비스가 자기 링크를 같은 트랜잭션에서 지운다)
 *
 * 복합 PK (from_id, from_type, to_note_id) = 같은 문서에서 같은 노트를 여러 번
 * 멘션해도 링크는 한 줄. 백링크 목록에 같은 출처가 두 번 뜨지 않는다.
 */
@Entity('study_note_links')
@Index('idx_snl_to_note', ['toNoteId'])
export class StudyNoteLink {
  @PrimaryColumn({ name: 'from_id', type: 'uuid' })
  fromId: string;

  @PrimaryColumn({ name: 'from_type', type: 'varchar', length: 16 })
  fromType: StudyNoteLinkFromType;

  @PrimaryColumn({ name: 'to_note_id', type: 'uuid' })
  toNoteId: string;

  @ManyToOne(() => StudyNote, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'to_note_id' })
  toNote: StudyNote;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
