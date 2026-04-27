import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('user_profiles')
export class UserProfile {
  @PrimaryColumn()
  user_id: string;

  @Column({ nullable: true }) name: string;
  @Column({ nullable: true }) name_hanja: string;
  @Column({ nullable: true }) gender: string;
  @Column({ type: 'date', nullable: true }) birthdate: string;
  @Column({ nullable: true }) phone: string;
  @Column({ nullable: true }) email_personal: string;

  @Column({ nullable: true }) military_branch: string;
  @Column({ nullable: true }) military_type: string;
  @Column({ type: 'date', nullable: true }) military_start: string;
  @Column({ type: 'date', nullable: true }) military_end: string;
  @Column({ nullable: true }) military_unit: string;

  @Column({ nullable: true }) goal_toeic: number;
  @Column({ type: 'text', nullable: true }) goal_certs: string;
  @Column({ type: 'text', nullable: true }) goal_other: string;
}
