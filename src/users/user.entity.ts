import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  kakao_id: string;

  @Column()
  nickname: string;

  @Column({ nullable: true })
  email: string;

  @Column({ nullable: true })
  refresh_token: string;

  @Column({ default: 'user' })
  role: string;

  @CreateDateColumn()
  created_at: Date;
}
