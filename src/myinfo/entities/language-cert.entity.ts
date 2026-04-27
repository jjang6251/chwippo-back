import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('myinfo_language_certs')
export class LanguageCert {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() user_id: string;
  @Column() cert_type: string;
  @Column({ nullable: true }) score_grade: string;
  @Column({ nullable: true }) issuer: string;
  @Column({ nullable: true }) cert_number: string;
  @Column({ type: 'date', nullable: true }) acquired_at: string;
  @Column({ nullable: true }) file_url: string;
}
