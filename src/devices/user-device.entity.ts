import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type DevicePlatform = 'ios' | 'android' | 'web';

@Entity('user_devices')
@Index(['userId'])
export class UserDevice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'device_token', type: 'varchar', length: 500, unique: true })
  deviceToken!: string;

  @Column({ type: 'varchar', length: 10 })
  platform!: DevicePlatform;

  @Column({ name: 'app_version', type: 'varchar', length: 20, nullable: true })
  appVersion!: string | null;

  @Column({
    name: 'last_active_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  lastActiveAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
