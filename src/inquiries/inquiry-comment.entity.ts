import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('inquiry_comments')
export class InquiryComment {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() inquiry_id: string;
  @Column() author_role: string; // 'user' | 'admin'
  @Column() author_id: string;
  @Column({ type: 'text' }) content: string;
  @CreateDateColumn() created_at: Date;
}
