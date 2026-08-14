import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Expo push **영수증(receipt) 확인 대기열** (R4).
 *
 * 발송 응답(ticket)의 `DeviceNotRegistered` 만으로는 죽은 토큰이 안 지워진다 —
 * FCM 은 그 에러를 대부분 영수증 단계에서 주기 때문이다 (안드로이드 시체 행의 원인).
 * 그래서 발송 시 받은 ticket id 를 여기 적어두고, cron 이 나중에 영수증을 조회해
 * 죽은 토큰을 정리한다.
 *
 * - `device_token` 은 FK 가 아니다. 발송과 영수증 확인 사이에 사용자가 로그아웃하면
 *   user_devices 행이 먼저 사라지는데, FK 였다면 그 삽입·조회가 깨진다.
 *   토큰 문자열만 들고 있다가 삭제 시점에 매칭하면 그런 경합이 아예 없다.
 * - 처리 여부는 `processed_at` 하나로 표현한다 (NULL = 미처리).
 */
@Entity('push_receipts')
@Index(['processedAt', 'createdAt'])
export class PushReceipt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Expo ticket id = 영수증 조회 키 (UUID 문자열) */
  @Column({ name: 'ticket_id', type: 'varchar', length: 100, unique: true })
  ticketId!: string;

  /** 이 티켓이 향한 device token (user_devices.device_token 과 같은 값) */
  @Column({ name: 'device_token', type: 'varchar', length: 500 })
  deviceToken!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** 영수증 조회를 마친 시각. NULL 이면 다음 주기에 다시 조회한다. */
  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;
}
