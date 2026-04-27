import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('myinfo_coverletter')
export class Coverletter {
  @PrimaryColumn() user_id: string;
  @Column({ type: 'text', nullable: true }) personality_strength: string;
  @Column({ type: 'text', nullable: true }) personality_weakness: string;
  @Column({ type: 'text', nullable: true }) background: string;
  @Column({ type: 'text', nullable: true }) job_competency: string;
  @Column({ type: 'text', nullable: true }) aspiration: string;
  @Column({ type: 'text', nullable: true }) own_strength: string;
  @UpdateDateColumn() updated_at: Date;
}
