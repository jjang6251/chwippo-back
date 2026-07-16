import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository, IsNull, Not } from 'typeorm';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { User } from '../users/user.entity';
import { DiscordNotifier, DISCORD_COLORS } from '../common/discord-notifier';
import { AppleTokenService } from './apple-token.service';

/**
 * Sign in with Apple (Apple Guideline 4.8) 백엔드 검증.
 *
 * 흐름:
 *   1. RN client (expo-apple-authentication) 가 사용자 동의 → Apple 이 identity_token (JWT) 발급
 *   2. client → POST /auth/apple/native { identityToken, fullName? } 로 전송
 *   3. 서버:
 *      a. Apple JWKS 로 identity_token 서명 검증
 *      b. payload 검증 (iss=https://appleid.apple.com, aud=<우리 bundle id>, exp>now)
 *      c. sub · email 추출
 *      d. users.apple_sub lookup or 신규 가입
 *      e. 우리 JWT 발급 (access + refresh)
 *
 * Apple JWKS · 24h 캐시 자동 rotation (`createRemoteJWKSet`).
 *
 * fullName · 최초 sign-in 시에만 전송 (Apple 정책 · 재로그인 시엔 null).
 * email · Apple relay 사용 시 `@privaterelay.appleid.com` 로 옴 · 실 이메일 전달 원치 않는 경우.
 */

export interface AppleIdentityTokenPayload extends JWTPayload {
  sub: string; // Apple user ID (앱별 · 영구 불변)
  email?: string; // Apple relay email or 실 이메일 (첫 로그인 or scope=email 요청 시)
  email_verified?: boolean | string;
  is_private_email?: boolean | string; // 'true'/'false' 문자열로 오는 경우도 있음
  aud: string; // 우리 iOS bundle id (네이티브) 또는 Services ID (웹 SIWA)
  iss: string; // https://appleid.apple.com
  auth_time?: number;
  nonce?: string; // 웹 SIWA authorize 에 보낸 nonce echo (CSRF·replay 방어)
  nonce_supported?: boolean;
}

export interface AppleUserInfo {
  appleSub: string;
  email: string | null;
  isPrivateEmail: boolean;
  fullName?: { givenName?: string | null; familyName?: string | null };
}

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';

@Injectable()
export class AppleAuthService {
  private readonly logger = new Logger(AppleAuthService.name);

  // JWKS 는 프로세스 lifetime 동안 캐시 · jose 가 내부 rotation 관리
  private readonly jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly config: ConfigService,
    private readonly discord: DiscordNotifier,
    private readonly appleTokenService: AppleTokenService,
  ) {}

  /**
   * Apple identity token 검증 후 payload 반환.
   *
   * @param expectedAudience 기본값 = BUNDLE_ID (네이티브). 웹 SIWA 콜백은 SERVICES_ID 명시 전달.
   *
   * 실패 시:
   *   - JWKS lookup 실패 · 네트워크 오류 → UnauthorizedException (Apple 서버 이슈)
   *   - 서명 검증 실패 → UnauthorizedException
   *   - aud/iss/exp mismatch → UnauthorizedException
   *   - sub 누락 → BadRequestException (malformed token)
   */
  async verifyIdentityToken(
    identityToken: string,
    expectedAudience: string | string[] = this.config.getOrThrow<string>(
      'APPLE_BUNDLE_ID',
    ),
  ): Promise<AppleIdentityTokenPayload> {
    if (!identityToken || typeof identityToken !== 'string') {
      throw new BadRequestException('identityToken 이 필요합니다.');
    }

    try {
      const { payload } = await jwtVerify(identityToken, this.jwks, {
        issuer: APPLE_ISSUER,
        audience: expectedAudience,
      });

      const applePayload = payload as AppleIdentityTokenPayload;
      if (!applePayload.sub) {
        throw new BadRequestException('identity token 에 sub 없음');
      }
      return applePayload;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(
        `Apple identity token verify failed: ${(err as Error).message}`,
      );
      throw new UnauthorizedException('Apple 로그인 검증 실패');
    }
  }

  /**
   * Payload → AppleUserInfo 정규화.
   *
   * Apple 은 첫 sign-in 시에만 fullName 을 client 에 반환하고 · 이후엔 절대 안 줌.
   * 따라서 fullName 은 client 가 저장 후 백엔드로 전달 · 이 서비스는 첫 sign-up 시에만 사용.
   */
  extractUserInfo(
    payload: AppleIdentityTokenPayload,
    fullName?: AppleUserInfo['fullName'],
  ): AppleUserInfo {
    // is_private_email 은 boolean 또는 'true'/'false' 문자열
    const isPrivate =
      payload.is_private_email === true || payload.is_private_email === 'true';

    return {
      appleSub: payload.sub,
      email: payload.email ?? null,
      isPrivateEmail: isPrivate,
      fullName,
    };
  }

  /**
   * Apple sub 로 user lookup or 신규 가입.
   *
   * Kakao 와 동일하게 race condition (unique violation 23505) 처리.
   */
  async findOrCreateAppleUser(
    userInfo: AppleUserInfo,
  ): Promise<{ user: User; isNew: boolean }> {
    let user = await this.userRepo.findOne({
      where: { appleSub: userInfo.appleSub },
    });
    let isNew = !user;

    if (!user) {
      const nickname = this.deriveNickname(userInfo);
      const email = userInfo.isPrivateEmail ? null : userInfo.email;
      const appleEmail = userInfo.isPrivateEmail ? userInfo.email : null;

      try {
        user = this.userRepo.create({
          appleSub: userInfo.appleSub,
          nickname,
          email,
          appleEmail,
          // kakao_id · 신규 SIWA 사용자는 NULL (CHECK constraint 로 하나 이상 요구)
        });
        user = await this.userRepo.save(user);
      } catch (err) {
        // 동시 SIWA 콜백 race
        const isUniqueViolation =
          err instanceof QueryFailedError &&
          (
            err as QueryFailedError & {
              driverError?: { code?: string };
            }
          ).driverError?.code === '23505';
        if (!isUniqueViolation) throw err;

        const existing = await this.userRepo.findOne({
          where: { appleSub: userInfo.appleSub },
        });
        if (!existing) throw err;
        this.logger.warn(
          `findOrCreateAppleUser race resolved (appleSub=${userInfo.appleSub})`,
        );
        user = existing;
        isNew = false;
      }
    }

    if (isNew) {
      void this.discord
        .notify(
          {
            title: '🎉 신규 가입',
            color: DISCORD_COLORS.green,
            fields: [
              { name: '경로', value: '애플', inline: true },
              { name: 'userId', value: user.id, inline: true },
            ],
          },
          'growth',
        )
        .catch(() => undefined);
    }

    return { user, isNew };
  }

  /**
   * fullName · email · appleSub 중 사용 가능한 것으로 nickname 생성.
   * 사용자가 이후 프로필에서 변경 가능.
   */
  private deriveNickname(info: AppleUserInfo): string {
    if (info.fullName?.givenName) {
      const given = info.fullName.givenName.trim();
      const family = info.fullName.familyName?.trim();
      return family ? `${family}${given}` : given;
    }
    if (info.email && !info.isPrivateEmail) {
      return info.email.split('@')[0] ?? 'user';
    }
    // relay email or 아무 정보 없음 → sub 앞 8자
    return `user_${info.appleSub.slice(0, 8)}`;
  }

  /**
   * authorizationCode 교환으로 얻은 refresh_token 저장 (best-effort 호출부에서 사용).
   * 탈퇴 시 Apple revoke 에 원문 필요 · 응답엔 미노출 (whitelist).
   */
  async storeRefreshToken(userId: string, refreshToken: string): Promise<void> {
    await this.userRepo.update(userId, { appleRefreshToken: refreshToken });
  }

  /**
   * authorizationCode → refresh_token 교환 후 저장 (완전 self-contained best-effort).
   *
   * 로그인/콜백 응답을 막지 않도록 컨트롤러가 fire-and-forget (`void`) 으로 호출.
   * isConfigured 가드 + 모든 에러 자체 흡수 (throw X) → unhandled rejection 없음.
   *
   * @param clientId 네이티브=BUNDLE_ID · 웹=SERVICES_ID
   * @param redirectUri 웹만 전달 (네이티브 생략)
   */
  async exchangeAndStoreRefreshToken(
    userId: string,
    code: string,
    clientId: string,
    redirectUri?: string,
  ): Promise<void> {
    if (!this.appleTokenService.isConfigured()) return;
    try {
      const refreshToken = await this.appleTokenService.exchangeCode(
        code,
        clientId,
        redirectUri,
      );
      if (refreshToken) {
        await this.storeRefreshToken(userId, refreshToken);
      }
    } catch (err) {
      this.logger.warn(
        `exchangeAndStoreRefreshToken 실패 (userId=${userId}): ${(err as Error).message}`,
      );
    }
  }

  /**
   * (테스트 편의) 서비스가 lookup 대상으로 삼는 user 개수 확인 · spec 에서 사용.
   */
  async countAppleUsers(): Promise<number> {
    return this.userRepo.count({ where: { appleSub: Not(IsNull()) } });
  }
}
