import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BigIntTransformer } from '../common/transformers/bigint.transformer';
import { User } from '../users/user.entity';
import { StudyNote } from './study-note.entity';

/** `image` = 사용자가 올린 사진 · `drawing` = 필기(PR-C 예약, 지금은 안 쓴다) */
export type NoteAttachmentKind = 'image' | 'drawing';

/**
 * **공부 노트 첨부** — 본문 이미지 한 장이 한 행이다.
 *
 * myinfo 증빙 파일은 항목 테이블에 인라인 컬럼(`file_url`·`file_size_bytes`)으로 붙어
 * 있지만, 노트는 한 문서에 여러 장이 들어가므로 전용 테이블이 필요하다.
 *
 * | 결정 | 이유 |
 * |---|---|
 * | `user_id` 를 따로 든다 | 용량 합산·탈퇴 정리가 노트를 거치지 않고 사용자로 바로 묶인다 (`note_id` 조인 없이 SUM) |
 * | `file_url` **UNIQUE** | 등록 재시도가 멱등해진다 — R2 PUT 은 성공했는데 등록 응답을 못 받은 프론트가 같은 URL 로 다시 불러도 행이 하나다 |
 * | `strokes_*` NULL | 필기(PR-C) 예약 컬럼. 지금은 항상 NULL 이지만 **용량 합산은 처음부터 더한다** — 나중에 더하기를 잊으면 조용히 새는 쪽이 훨씬 비싸다 |
 * | `kind` = VARCHAR + CHECK | 이 스키마에 PG enum 은 하나도 없다 (`study_note_links.from_type` 과 같은 규약) |
 * | note_id·user_id 둘 다 CASCADE | 노트를 지우면 행이 사라지고, 탈퇴하면 전멸한다. R2 객체 정리는 코드가 best-effort 로 따로 한다 |
 */
@Entity('note_attachments')
@Index('idx_na_note', ['noteId'])
@Index('idx_na_user', ['userId'])
export class NoteAttachment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'note_id', type: 'uuid' })
  noteId: string;

  @ManyToOne(() => StudyNote, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'note_id' })
  note: StudyNote;

  @Column({ type: 'varchar', length: 16 })
  kind: NoteAttachmentKind;

  /** R2 public URL. 소유권은 `FilesService.assertOwnFileUrl` 이 prefix 로 잠근다 */
  @Column({ name: 'file_url', type: 'varchar' })
  fileUrl: string;

  @Column({
    name: 'file_size_bytes',
    type: 'bigint',
    transformer: BigIntTransformer,
  })
  fileSizeBytes: number;

  /** 필기 stroke JSON (PR-C 예약) */
  @Column({ name: 'strokes_url', type: 'varchar', nullable: true })
  strokesUrl: string | null;

  @Column({
    name: 'strokes_size_bytes',
    type: 'bigint',
    nullable: true,
    transformer: BigIntTransformer,
  })
  strokesSizeBytes: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
