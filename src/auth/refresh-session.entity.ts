import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/**
 * 세션 지속성 웨이브 (B안 — 토큰 패밀리) — 기기(체인) 단위 refresh 세션.
 *
 * 발급 토큰(row-per-token)은 `refresh_tokens` 로 분리. 이 테이블은 기기 체인의
 * 수명·상한·revoke 상태만 관리한다.
 *
 * - `id` = refresh JWT 의 `sid` claim (로그인마다 새로 발급 · session fixation 차단 CWE-384)
 * - sliding: 정상 rotation 시 `expires_at` +60일 / absolute cap: `created_at` +180일 초과 시 rotation 거부
 * - `revoked_at` = 세션(기기 체인) 무효화 시각. NOT NULL 이면 그 세션의 refresh_tokens 전부 무효
 *   (탈취 감지·로그아웃·기기 상한 evict). rotation 조회 join 에서 `revoked_at IS NULL` 로 차단.
 * - user 탈퇴 시 FK ON DELETE CASCADE 로 세션·토큰 자동 정리
 */
@Entity('refresh_sessions')
@Index(['userId'])
export class RefreshSession {
  /** 세션(기기 체인) 식별자 — refresh JWT `sid` claim. 앱이 uuid 발급 */
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /** 최초 로그인 시각 — absolute cap(180일) 기준 */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** sliding 만료 (정상 rotation 시 +60일 갱신) */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  /** UA/platform 문자열 (표시용 · PII 아님) */
  @Column({ name: 'device_info', type: 'varchar', length: 255, nullable: true })
  deviceInfo!: string | null;

  /** 세션 무효화 시각 — NOT NULL 이면 그 세션의 토큰 전부 무효 (탈취·로그아웃·evict) */
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;
}
