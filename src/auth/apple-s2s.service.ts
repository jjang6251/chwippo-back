import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { User } from '../users/user.entity';
import { UserDeletionLog } from '../users/user-deletion-log.entity';
import { DiscordNotifier, DISCORD_COLORS } from '../common/discord-notifier';
import { StorageUsageService } from '../myinfo/storage-usage.service';
import { FilesService } from '../files/files.service';

/**
 * Sign in with Apple — Server-to-Server Notifications (2026-01-01 필수).
 *
 * Apple 이 사용자 계정 이벤트를 우리 서버로 알림:
 *   - account-delete  : Apple ID 자체 삭제 → 우리 user 도 삭제
 *   - consent-revoked : Apple 계정에서 우리 앱 권한 회수 → 우리 user 삭제 (또는 apple_sub 해제)
 *   - email-disabled  : private relay 전달 비활성화 → 로그만 (email 은 유효 유지, 다만 미도달 가능)
 *   - email-enabled   : private relay 전달 재활성화 → 로그만
 *
 * Payload 구조 (Apple 문서):
 * ```
 * {
 *   "iss": "https://appleid.apple.com",
 *   "aud": "<우리 bundle id>",
 *   "iat": <unix>,
 *   "jti": "<unique>",
 *   "events": "{\"type\":\"...\",\"sub\":\"...\",\"event_time\":...}"   ← stringified JSON
 * }
 * ```
 *
 * 인증 방식 = Apple JWKS 서명 검증만 (endpoint 는 public). 서명 통과 = Apple 이 보낸 것.
 *
 * 삭제 정책:
 *   - user 가 Apple only (kakao_id NULL) → 완전 삭제 + R2 cascade
 *   - user 가 Apple + Kakao (병합 · 미래) → apple_sub 만 NULL 처리 (Kakao 로 계속 로그인 가능)
 *
 * Kakao unlink 호출 X — Apple 이벤트 처리 시엔 Apple 측만 정리.
 * (identity-provider.service.unlinkKakao 는 사용자 명시 탈퇴 시에만 호출)
 */

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';

export type AppleS2SEventType =
  | 'email-disabled'
  | 'email-enabled'
  | 'consent-revoked'
  | 'account-delete';

export interface AppleS2SEvent {
  type: AppleS2SEventType;
  sub: string;
  email?: string;
  is_private_email?: boolean | string;
  event_time?: number;
}

interface AppleS2SPayload extends JWTPayload {
  events: string; // stringified JSON of AppleS2SEvent
}

export type AppleS2SResult =
  | { action: 'deleted'; userId: string }
  | { action: 'apple_unlinked'; userId: string } // kakao 있는 병합 계정
  | { action: 'user_not_found'; sub: string }
  | { action: 'logged'; type: AppleS2SEventType };

@Injectable()
export class AppleS2SService {
  private readonly logger = new Logger(AppleS2SService.name);

  private readonly jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly config: ConfigService,
    private readonly storageUsage: StorageUsageService,
    private readonly filesService: FilesService,
    private readonly discord: DiscordNotifier,
    @InjectRepository(UserDeletionLog)
    private readonly deletionLogRepo: Repository<UserDeletionLog>,
  ) {}

  /**
   * Notification 처리 총괄.
   * 1) JWT 서명 · iss/aud 검증
   * 2) events 필드 파싱
   * 3) type 별 dispatch
   */
  async handleNotification(payload: string): Promise<AppleS2SResult> {
    const event = await this.verifyAndParse(payload);
    this.logger.log(
      `Apple S2S event received (type=${event.type} · sub=${event.sub.slice(0, 12)}...)`,
    );

    void this.discord
      .notify(
        {
          title: '🍎 Apple S2S 이벤트',
          color: DISCORD_COLORS.gray,
          fields: [
            { name: 'type', value: event.type, inline: true },
            {
              name: 'sub',
              value: `${event.sub.slice(0, 12)}...`,
              inline: true,
            },
          ],
        },
        'growth',
      )
      .catch(() => undefined);

    switch (event.type) {
      case 'account-delete':
      case 'consent-revoked':
        return this.deleteOrUnlinkUser(event.sub);
      case 'email-disabled':
      case 'email-enabled':
        // 현재는 로그만 · 필요 시 user.pending_notification 으로 사용자 안내 확장
        return { action: 'logged', type: event.type };
      default:
        // 신규 event type 추가 대비 (Apple 이 나중에 확장)
        this.logger.warn(
          `Unknown Apple S2S event type: ${(event as { type: string }).type}`,
        );
        return { action: 'logged', type: event.type };
    }
  }

  /**
   * JWT 서명 검증 + events 필드 파싱.
   *
   * 실패 케이스:
   *   - payload 비어있음 → BadRequestException
   *   - 서명·iss·aud·exp mismatch → UnauthorizedException
   *   - events 파싱 실패 → BadRequestException
   *   - events.type · events.sub 누락 → BadRequestException
   */
  async verifyAndParse(payload: string): Promise<AppleS2SEvent> {
    if (!payload || typeof payload !== 'string') {
      throw new BadRequestException('payload 가 필요합니다.');
    }

    const expectedAudience = this.config.getOrThrow<string>('APPLE_BUNDLE_ID');

    let verified: AppleS2SPayload;
    try {
      const { payload: verifiedPayload } = await jwtVerify(payload, this.jwks, {
        issuer: APPLE_ISSUER,
        audience: expectedAudience,
      });
      verified = verifiedPayload as AppleS2SPayload;
    } catch (err) {
      this.logger.warn(
        `Apple S2S JWT verify failed: ${(err as Error).message}`,
      );
      throw new UnauthorizedException('Apple S2S 서명 검증 실패');
    }

    if (!verified.events || typeof verified.events !== 'string') {
      throw new BadRequestException('events 필드 누락');
    }

    let event: AppleS2SEvent;
    try {
      event = JSON.parse(verified.events) as AppleS2SEvent;
    } catch {
      throw new BadRequestException('events JSON 파싱 실패');
    }

    if (!event.type || !event.sub) {
      throw new BadRequestException('event.type · event.sub 필수');
    }

    return event;
  }

  /**
   * user 삭제 or apple_sub 해제.
   * - Apple only (kakao_id NULL) → 완전 삭제 + R2 cascade
   * - Apple + Kakao 병합 → apple_sub / apple_email null (Kakao 로 계속 로그인 가능)
   */
  private async deleteOrUnlinkUser(appleSub: string): Promise<AppleS2SResult> {
    const user = await this.userRepo.findOne({ where: { appleSub } });
    if (!user) {
      this.logger.log(`Apple S2S delete: user not found (sub=${appleSub})`);
      return { action: 'user_not_found', sub: appleSub };
    }

    if (user.kakaoId) {
      user.appleSub = null;
      user.appleEmail = null;
      await this.userRepo.save(user);
      this.logger.log(
        `Apple S2S: unlinked apple only (userId=${user.id}, kakao 유지)`,
      );
      return { action: 'apple_unlinked', userId: user.id };
    }

    const fileUrls = await this.storageUsage.collectAllFileUrls(user.id);
    await this.userRepo.remove(user);
    for (const url of fileUrls) {
      await this.filesService.deleteFile(url);
    }
    void this.deletionLogRepo
      .insert({ provider: 'apple', source: 'apple_s2s' })
      .catch(() => undefined);
    this.logger.log(`Apple S2S: user hard-deleted (id=${user.id})`);
    return { action: 'deleted', userId: user.id };
  }
}
