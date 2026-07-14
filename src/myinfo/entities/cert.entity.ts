import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BigIntTransformer } from '../../common/transformers/bigint.transformer';

@Entity('myinfo_certs')
export class Cert {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() user_id: string;
  @Column() name: string;
  @Column({ nullable: true }) issuer: string;
  @Column({ nullable: true }) cert_number: string;
  @Column({ type: 'date', nullable: true }) acquired_at: string;
  @Column({ type: 'date', nullable: true }) expires_at: string;
  @Column({ nullable: true }) file_url: string | null;
  @Column({ type: 'bigint', nullable: true, transformer: BigIntTransformer })
  file_size_bytes: number | null;
}
