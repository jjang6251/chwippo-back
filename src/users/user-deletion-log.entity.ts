import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type DeletionSource = 'self' | 'apple_s2s';

/**
 * 탈퇴 로그 — 집계용 (users hard delete 대비). 개인정보 없음 (카운트만).
 */
@Entity('user_deletion_logs')
export class UserDeletionLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** 'kakao' · 'apple' · 'kakao+apple' · '-' */
  @Column({ type: 'varchar', length: 20 })
  provider!: string;

  @Column({ type: 'varchar', length: 20 })
  source!: DeletionSource;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
