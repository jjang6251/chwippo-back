import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('myinfo_awards')
export class Award {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() user_id: string;
  @Column() contest_name: string;
  @Column({ nullable: true }) award_name: string;
  @Column({ nullable: true }) org: string;
  @Column({ type: 'date', nullable: true }) awarded_at: string;
  @Column({ length: 200, nullable: true }) content: string;
  @Column({ nullable: true }) file_url: string;
}
