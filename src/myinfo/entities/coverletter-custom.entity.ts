import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('myinfo_coverletter_custom')
export class CoverletterCustom {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() user_id: string;
  @Column() label: string;
  @Column({ type: 'text', nullable: true }) content: string;
  @Column() order_index: number;
}
