import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/user.entity';
import { TierConfig, type CoinTier } from './tier-config.entity';

/**
 * PR_B1 — 사용자별 코인 잔여 + tier + 갱신 schedule.
 *
 * **컬럼 의미**:
 * - `balance` — 현재 잔여 코인. **음수 허용** (마이너스 carry-over 정책)
 * - `cycleStartAt` — 현재 cycle 시작 시각
 * - `nextResetAt` — 다음 reset 시각 (lazy + cron 의 기준)
 * - `planStartedAt` — 유료 시작 시각 (Free 는 NULL)
 * - `planExpiresAt` — 유료 만료 시각. cron 이 < NOW 인 row 를 free 강등
 *
 * **race-safe**: balance UPDATE 는 atomic `WHERE balance >= required` 사용.
 *   단 마이너스 허용이라 차감 시 WHERE 조건 X (항상 UPDATE 성공). 추정 check 는 별도 step.
 */
@Entity('user_coin_balances')
export class UserCoinBalance {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', length: 20, default: 'free' })
  tier: CoinTier;

  @ManyToOne(() => TierConfig)
  @JoinColumn({ name: 'tier', referencedColumnName: 'tier' })
  tierConfig: TierConfig;

  @Column({ type: 'numeric', precision: 8, scale: 1, default: 0 })
  balance: string; // NUMERIC → string (음수 가능, e.g. '-15.5')

  @Column({ name: 'cycle_start_at', type: 'timestamptz' })
  cycleStartAt: Date;

  @Column({ name: 'next_reset_at', type: 'timestamptz' })
  nextResetAt: Date;

  @Column({ name: 'plan_started_at', type: 'timestamptz', nullable: true })
  planStartedAt: Date | null;

  @Column({ name: 'plan_expires_at', type: 'timestamptz', nullable: true })
  planExpiresAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
