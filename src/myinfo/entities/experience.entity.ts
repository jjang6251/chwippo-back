import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('myinfo_experiences')
export class Experience {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() user_id: string;
  @Column() activity_name: string;
  @Column({ nullable: true }) org: string;
  @Column({ type: 'date', nullable: true }) start_at: string;
  @Column({ type: 'date', nullable: true }) end_at: string;
  @Column({ type: 'text', nullable: true }) content: string;
}
