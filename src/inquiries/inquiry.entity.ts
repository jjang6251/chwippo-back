import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('inquiries')
export class Inquiry {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ nullable: true }) user_id: string;
  @Column() category: string;
  @Column() title: string;
  @Column({ type: 'text' }) content: string;
  @Column({ default: 'PENDING' }) status: string;
  @Column({ type: 'text', nullable: true }) admin_reply: string;
  @Column({ type: 'timestamptz', nullable: true }) replied_at: Date;
  @CreateDateColumn() created_at: Date;
}
