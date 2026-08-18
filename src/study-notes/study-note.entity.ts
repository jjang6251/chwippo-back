import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { StudyNoteFolder } from './study-note-folder.entity';
import { User } from '../users/user.entity';

/**
 * **공부 노트** — 지원 카드에 붙지 않는 자유 노트 (CS 정리·기출·오답 노트).
 *
 * 카드 안 「준비 노트」(`step_note_sheets`) 와 펜은 같고 노트북이 다르다 —
 * 이쪽은 회사와 무관한 개인 학습 자료라 폴더·백링크·읽기모드가 붙는다.
 *
 * | 결정 | 이유 |
 * |---|---|
 * | `title` **빈 문자열 허용** | 생성이 노션식이다 — 버튼 한 번에 빈 노트가 만들어지고 제목은 나중에 쓴다. 빈 제목을 400 으로 막으면 그 흐름 자체가 성립하지 않는다 (화면 표시는 프론트가 「제목 없음」) |
 * | `folder_id ... SET NULL` | 폴더를 지워도 노트는 「미분류」로 남는다 (CEO 결정 4). 노트는 사용자가 쓴 원본이라 폴더 정리의 부수효과로 사라지면 안 된다 |
 * | `INDEX (user_id, updated_at DESC)` | 허브의 유일한 조회 패턴이 "내 노트를 최근 수정순으로" 하나뿐 |
 */
@Entity('study_notes')
@Index('idx_sn_user_updated', ['userId', 'updatedAt'])
export class StudyNote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /** 미분류 = null. 폴더 삭제 시 DB 가 여기를 NULL 로 만든다 */
  @Column({ name: 'folder_id', type: 'uuid', nullable: true })
  folderId: string | null;

  @ManyToOne(() => StudyNoteFolder, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'folder_id' })
  folder: StudyNoteFolder | null;

  /** trim 후 0~100자. **빈 문자열은 정상 값** (제목 없는 노트) */
  @Column({ type: 'varchar', length: 100, default: '' })
  title: string;

  /** tiptap doc JSON 문자열. 빈 노트는 null */
  @Column({ type: 'text', nullable: true })
  content: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
