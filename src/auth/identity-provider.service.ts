import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppleTokenService } from './apple-token.service';

/**
 * 소셜 로그인 프로바이더 (Kakao · Apple) 관련 서버-서버 액션 헬퍼.
 *
 * 주 사용처: 회원 탈퇴 시 프로바이더 측 unlink / revoke
 * (Apple Guideline 5.1.1(v) · 카카오 개인정보 처리방침 준수).
 *
 * ## Kakao Unlink
 * `POST https://kapi.kakao.com/v1/user/unlink` (Admin key 방식):
 *   - Authorization: KakaoAK {ADMIN_KEY}
 *   - target_id_type=user_id · target_id={kakao_id}
 * 실패 시 로그만 남기고 사용자 삭제는 계속 진행 (best-effort).
 * 이유: 카카오 API 일시 장애로 로컬 탈퇴가 막히면 사용자 경험 최악.
 *
 * ## Apple Revoke
 * SIWA revoke 시 client_secret (ES256 JWT) + refresh_token 필요.
 * 로그인 시 authorizationCode 를 교환해 저장한 `apple_refresh_token` 을
 * `AppleTokenService.revoke()` 로 무효화 (Apple `/auth/revoke`).
 * refresh_token 이 네이티브(BUNDLE_ID)·웹(SERVICES_ID) 어느 쪽 발급인지 추적 안 하므로
 * BUNDLE_ID 로 시도 후 실패 시 SERVICES_ID 로 재시도 (양쪽 best-effort).
 * refresh_token 미저장(구버전·교환 실패)·미설정 시 스킵 — 로컬 삭제는 정상 진행.
 */

const KAKAO_UNLINK_URL = 'https://kapi.kakao.com/v1/user/unlink';

@Injectable()
export class IdentityProviderService {
  private readonly logger = new Logger(IdentityProviderService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly appleTokenService: AppleTokenService,
  ) {}

  /**
   * Kakao 계정 연결 해제 (Admin key 방식).
   *
   * @returns `true` = 성공, `false` = 실패 (사용자 삭제는 계속 진행).
   *
   * 실패 케이스 (모두 best-effort · throw X):
   *   - Admin key 미설정 → 로그 warn 후 false
   *   - Kakao API 4xx (이미 unlink 됨 · 유효하지 않은 kakao_id) → false
   *   - 네트워크 오류 → false
   */
  async unlinkKakao(kakaoId: string): Promise<boolean> {
    const adminKey = this.config.get<string>('KAKAO_ADMIN_KEY');
    if (!adminKey) {
      this.logger.warn(
        `unlinkKakao skip: KAKAO_ADMIN_KEY not configured (kakaoId=${kakaoId})`,
      );
      return false;
    }

    try {
      const body = new URLSearchParams({
        target_id_type: 'user_id',
        target_id: kakaoId,
      }).toString();

      const res = await fetch(KAKAO_UNLINK_URL, {
        method: 'POST',
        headers: {
          Authorization: `KakaoAK ${adminKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });

      if (!res.ok) {
        this.logger.warn(
          `unlinkKakao failed (kakaoId=${kakaoId}, status=${res.status})`,
        );
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `unlinkKakao error (kakaoId=${kakaoId}): ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Apple SIWA 계정 revoke (Guideline 5.1.1(v)).
   *
   * @param appleRefreshToken 로그인 시 교환·저장한 refresh_token (없으면 revoke 스킵)
   * @param appleSub 로깅용 (토큰 원문은 미로깅)
   * @returns `true` = revoke 성공, `false` = 스킵·실패 (모두 로컬 삭제는 계속 진행).
   *
   * best-effort (throw X):
   *   - refresh_token null (구버전·교환 실패 이력) → 스킵
   *   - AppleTokenService 미설정 (.p8 등 없음) → 스킵
   *   - BUNDLE_ID 로 revoke 실패 → SERVICES_ID (설정 시) 로 재시도
   */
  async revokeApple(
    appleRefreshToken: string | null,
    appleSub: string,
  ): Promise<boolean> {
    const subTag = appleSub.slice(0, 12);

    if (!appleRefreshToken) {
      this.logger.log(
        `revokeApple 스킵: refresh_token 미저장 (appleSub=${subTag}...)`,
      );
      return false;
    }
    if (!this.appleTokenService.isConfigured()) {
      this.logger.warn(
        `revokeApple 스킵: Apple 토큰 설정 누락 (appleSub=${subTag}...)`,
      );
      return false;
    }

    const bundleId = this.config.get<string>('APPLE_BUNDLE_ID');
    const servicesId = this.config.get<string>('APPLE_SERVICES_ID');

    // 어느 client 로 발급된 refresh_token 인지 추적 안 하므로 양쪽 시도 (best-effort)
    const clientIds = [bundleId, servicesId].filter((v): v is string => !!v);

    for (const clientId of clientIds) {
      const ok = await this.appleTokenService.revoke(
        appleRefreshToken,
        clientId,
      );
      if (ok) {
        this.logger.log(
          `revokeApple 성공 (appleSub=${subTag}..., clientId=${clientId})`,
        );
        return true;
      }
    }

    this.logger.warn(
      `revokeApple 실패: 모든 client_id 시도 실패 (appleSub=${subTag}...) · 로컬 삭제는 진행`,
    );
    return false;
  }
}
