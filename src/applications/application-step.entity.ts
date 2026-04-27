import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('application_steps')
export class ApplicationStep {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  application_id: string;

  @Column()
  order_index: number;

  @Column()
  name: string;

  @Column({ type: 'timestamptz', nullable: true })
  scheduled_date: Date;

  @Column({ nullable: true })
  location: string;
}
