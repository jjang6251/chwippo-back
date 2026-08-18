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
import { User } from '../users/user.entity';

/**
 * 공부 노트 **폴더** — 노트 허브의 1단 그룹.
 *
 * | 결정 | 이유 |
 * |---|---|
 * | `user_id ... CASCADE` | 탈퇴하면 폴더도 사라진다 (다른 사용자 데이터와 같은 규칙) |
 * | `parent_id ... SET NULL` | **1차는 중첩 없음**. 컬럼은 2차 중첩용 예약이고, 1단 제약은 서비스가 본다. 부모가 사라지면 자식은 최상위로 올라온다 — 폴더 삭제가 내용을 지우지 않는다는 원칙(노트도 `SET NULL`)과 같은 방향 |
 * | `sort_order` | 2차 드래그 정렬용 **예약 컬럼**. 1차 화면은 가나다순 자동 정렬이라 아무도 안 쓴다 |
 */
@Entity('study_note_folders')
@Index('idx_snf_user', ['userId'])
export class StudyNoteFolder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /** 폴더 이름. trim 후 1~50자 (판정은 서비스가 단일 지점에서) */
  @Column({ type: 'varchar', length: 50 })
  name: string;

  /** 2차 드래그 정렬 예약. 1차는 이름 가나다순이라 항상 0 */
  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  /** 2차 중첩 예약. 1차는 서비스가 **항상 1단** 으로 막는다 */
  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
