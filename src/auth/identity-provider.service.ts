import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
 * 현재 우리는 refresh_token 을 교환하지 않고 identity_token 만 검증하므로
 * revoke API 호출 불가 → 로컬 삭제로 대체 (Apple 정책 위반 X).
 *
 * 향후 refresh_token 도입 시 확장 지점.
 */

const KAKAO_UNLINK_URL = 'https://kapi.kakao.com/v1/user/unlink';

@Injectable()
export class IdentityProviderService {
  private readonly logger = new Logger(IdentityProviderService.name);

  constructor(private readonly config: ConfigService) {}

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
   * Apple SIWA 계정 revoke.
   *
   * 현재 refresh_token 미저장 · Apple API 호출 불가.
   * 향후 refresh_token 교환 도입 시:
   *   POST https://appleid.apple.com/auth/revoke
   *     client_id={APPLE_BUNDLE_ID} · client_secret={JWT (ES256)} ·
   *     token={refresh_token} · token_type_hint=refresh_token
   *
   * 지금은 로그만 남기고 로컬 삭제만 수행 (Apple 정책 상 로컬 삭제는 문제 없음).
   */
  async revokeApple(appleSub: string): Promise<boolean> {
    this.logger.log(
      `revokeApple stub: refresh_token 미저장으로 API 호출 불가 · 로컬 삭제만 (appleSub=${appleSub.slice(0, 12)}...)`,
    );
    return false;
  }
}
