import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('myinfo_educations')
export class Education {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() user_id: string;
  @Column() school_name: string;
  @Column({ nullable: true }) major: string;
  @Column({ nullable: true }) minor: string; // deprecated — minors(JSONB)로 대체
  @Column({ type: 'jsonb', nullable: true }) minors: Array<{
    type: string;
    name: string;
  }> | null;
  @Column({ nullable: true }) degree: string; // 학사/석사/박사/전문학사/고졸 등
  @Column({ type: 'numeric', precision: 4, scale: 2, nullable: true })
  gpa: string;
  @Column({ type: 'numeric', precision: 4, scale: 2, nullable: true })
  gpa_max: string;
  @Column({ type: 'date', nullable: true }) start_at: string;
  @Column({ type: 'date', nullable: true }) end_at: string;
  @Column({ nullable: true }) status: string; // 재학중/졸업/휴학/수료/중퇴/편입/졸업예정
  @Column({ nullable: true }) location: string;
  @Column({ nullable: true }) file_url: string;
}
