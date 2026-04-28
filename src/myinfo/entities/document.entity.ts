import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('myinfo_documents')
export class Document {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() user_id: string;
  @Column() title: string;
  @Column({ nullable: true }) category: string;
  @Column() file_url: string;
  @CreateDateColumn() created_at: Date;
}
