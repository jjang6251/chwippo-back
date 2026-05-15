import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BigIntTransformer } from '../../common/transformers/bigint.transformer';

@Entity('myinfo_documents')
export class Document {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() user_id: string;
  @Column() title: string;
  @Column({ nullable: true }) category: string;
  @Column() file_url: string;
  @Column({ type: 'bigint', nullable: true, transformer: BigIntTransformer })
  file_size_bytes: number | null;
  @CreateDateColumn() created_at: Date;
}
