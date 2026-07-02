import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { KakaoUser } from './auth.service';

/**
 * W2 RN — 카카오 네이티브 SDK 인증.
 *
 * 흐름:
 *   1. Mobile client (`@react-native-kakao/user` KakaoSDK.login()) → Kakao access_token 획득
 *   2. Client → POST /auth/kakao/native { accessToken }
 *   3. 서버가 Kakao API `GET /v2/user/me` 로 사용자 정보 조회 (access_token = 인증)
 *   4. 응답 매핑 → AuthService.findOrCreateKakaoUser → 우리 JWT 발급
 *
 * Kakao 서버가 access_token 을 검증하고 사용자 정보 반환.
 * access_token 무효 시 Kakao 가 401 반환 → 우리도 UnauthorizedException.
 *
 * 응답 스펙 (Kakao):
 * ```
 * {
 *   "id": 123456789,                          // Kakao user id (long)
 *   "kakao_account": {
 *     "email": "foo@example.com" (optional),
 *     "profile": {
 *       "nickname": "홍길동" (optional)
 *     }
 *   }
 * }
 * ```
 * email · nickname 은 사용자 동의 항목에 따라 없을 수 있음.
 */

const KAKAO_USER_ME_URL = 'https://kapi.kakao.com/v2/user/me';

interface KakaoUserMeResponse {
  id: number;
  kakao_account?: {
    email?: string;
    profile?: {
      nickname?: string;
    };
  };
}

@Injectable()
export class KakaoNativeService {
  private readonly logger = new Logger(KakaoNativeService.name);

  /**
   * Kakao access_token 을 검증하고 KakaoUser 로 매핑.
   *
   * 실패 케이스:
   *   - 빈/누락 token → BadRequestException
   *   - Kakao 401/403 → UnauthorizedException (token 무효)
   *   - Kakao 5xx / 네트워크 → UnauthorizedException (로그 warn)
   *   - 응답에 id 없음 (malformed) → UnauthorizedException
   */
  async verifyAndFetchUser(accessToken: string): Promise<KakaoUser> {
    if (!accessToken || typeof accessToken !== 'string') {
      throw new BadRequestException('accessToken 이 필요합니다.');
    }

    let res: Response;
    try {
      res = await fetch(KAKAO_USER_ME_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        },
      });
    } catch (err) {
      this.logger.warn(
        `Kakao /user/me 네트워크 오류: ${(err as Error).message}`,
      );
      throw new UnauthorizedException('카카오 인증 실패');
    }

    if (!res.ok) {
      this.logger.warn(`Kakao /user/me 실패 (status=${res.status})`);
      throw new UnauthorizedException('카카오 인증 실패');
    }

    let body: KakaoUserMeResponse;
    try {
      body = (await res.json()) as KakaoUserMeResponse;
    } catch {
      throw new UnauthorizedException('카카오 응답 파싱 실패');
    }

    if (typeof body.id !== 'number') {
      throw new UnauthorizedException('카카오 응답에 id 누락');
    }

    const nickname =
      body.kakao_account?.profile?.nickname?.trim() ||
      `user_${String(body.id).slice(0, 8)}`;

    return {
      kakaoId: String(body.id),
      nickname,
      email: body.kakao_account?.email ?? null,
    };
  }
}
