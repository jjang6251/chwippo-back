import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('myinfo_coverletter')
export class Coverletter {
  @PrimaryColumn() user_id: string;
  @Column({ type: 'text', nullable: true }) personality: string; // 성격 장단점
  @Column({ type: 'text', nullable: true }) background: string; // 성장 배경
  @Column({ type: 'text', nullable: true }) job_competency: string; // 직무 역량·핵심 경험
  @Column({ type: 'text', nullable: true }) own_strength: string; // 나만의 강점
  @Column({ type: 'text', nullable: true }) collaboration: string; // 갈등 해결·협업 경험
  @Column({ type: 'text', nullable: true }) challenge: string; // 도전·실패 경험
  @UpdateDateColumn() updated_at: Date;
}
