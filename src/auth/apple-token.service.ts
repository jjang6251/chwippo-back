import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, importPKCS8 } from 'jose';

/**
 * Sign in with Apple — server-to-server 토큰 교환 · revoke 헬퍼.
 *
 * Apple revoke (Guideline 5.1.1(v)) · 웹 SIWA 콜백에서 공용으로 사용.
 *
 * ## client_secret (ES256 JWT)
 * Apple `/auth/token`·`/auth/revoke` 는 client_secret 자리에 우리가 서명한 JWT 를 요구:
 *   { iss: TEAM_ID, sub: CLIENT_ID, aud: 'https://appleid.apple.com', iat, exp(+5분), header.kid: KEY_ID }
 * `.p8` private key (ES256) 로 서명. PEM 은 env 에 `\n` 리터럴로 저장되므로 실제 개행으로 복원.
 *
 * ## 정책
 * - 외부 호출은 fetch + 10초 timeout · 재시도 없음.
 * - 실패(비200·네트워크·토큰 없음)는 전부 warn 로그 후 null/false — throw X (best-effort).
 * - TEAM_ID·KEY_ID·PRIVATE_KEY 중 하나라도 비면 미설정 → `isConfigured()` false · 호출부에서 스킵.
 */

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const APPLE_AUDIENCE = 'https://appleid.apple.com';
const FETCH_TIMEOUT_MS = 5_000;

@Injectable()
export class AppleTokenService {
  private readonly logger = new Logger(AppleTokenService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * revoke·토큰 교환에 필요한 Apple 콘솔 산출물이 모두 설정됐는지.
   * 하나라도 비면 관련 흐름을 스킵 (로컬/CI 부팅 안전).
   */
  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('APPLE_TEAM_ID') &&
      this.config.get<string>('APPLE_KEY_ID') &&
      this.config.get<string>('APPLE_PRIVATE_KEY'),
    );
  }

  /**
   * client_secret 용 ES256 JWT 서명.
   * env 미설정 시 명확한 에러 로그 후 throw (호출부는 isConfigured() 로 사전 가드).
   */
  private async signClientSecret(clientId: string): Promise<string> {
    const teamId = this.config.get<string>('APPLE_TEAM_ID');
    const keyId = this.config.get<string>('APPLE_KEY_ID');
    const privateKeyPem = this.config.get<string>('APPLE_PRIVATE_KEY');

    if (!teamId || !keyId || !privateKeyPem) {
      this.logger.error(
        'signClientSecret 실패: APPLE_TEAM_ID·APPLE_KEY_ID·APPLE_PRIVATE_KEY 중 미설정',
      );
      throw new Error('Apple client_secret 서명 설정 누락');
    }

    // env 에는 개행이 \n 리터럴로 저장됨 → 실제 개행으로 복원 후 PKCS8 로드
    const pem = privateKeyPem.replace(/\\n/g, '\n');
    const key = await importPKCS8(pem, 'ES256');

    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: keyId })
      .setIssuer(teamId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setSubject(clientId)
      .setAudience(APPLE_AUDIENCE)
      .sign(key);
  }

  /**
   * authorization code → refresh_token 교환.
   *
   * @param clientId 네이티브=BUNDLE_ID · 웹=SERVICES_ID
   * @param redirectUri 웹만 전달 (네이티브는 생략)
   * @returns refresh_token · 실패 시 null (best-effort).
   */
  async exchangeCode(
    code: string,
    clientId: string,
    redirectUri?: string,
  ): Promise<string | null> {
    try {
      const clientSecret = await this.signClientSecret(clientId);
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
      });
      if (redirectUri) body.set('redirect_uri', redirectUri);

      const res = await this.postForm(APPLE_TOKEN_URL, body);
      if (!res || !res.ok) {
        this.logger.warn(
          `exchangeCode 실패 (clientId=${clientId}, status=${res?.status ?? 'network'})`,
        );
        return null;
      }

      const json = (await res.json()) as { refresh_token?: string };
      if (!json.refresh_token) {
        this.logger.warn('exchangeCode: 응답에 refresh_token 없음');
        return null;
      }
      return json.refresh_token;
    } catch (err) {
      this.logger.warn(`exchangeCode error: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * refresh_token revoke.
   *
   * @param clientId 토큰 발급한 client (네이티브=BUNDLE_ID · 웹=SERVICES_ID)
   * @returns 200 이면 true · 아니면 false (best-effort).
   */
  async revoke(refreshToken: string, clientId: string): Promise<boolean> {
    try {
      const clientSecret = await this.signClientSecret(clientId);
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        token: refreshToken,
        token_type_hint: 'refresh_token',
      });

      const res = await this.postForm(APPLE_REVOKE_URL, body);
      if (!res || !res.ok) {
        this.logger.warn(
          `revoke 실패 (clientId=${clientId}, status=${res?.status ?? 'network'})`,
        );
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`revoke error: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * x-www-form-urlencoded POST · 10초 timeout · 재시도 없음.
   * 네트워크 오류 시 null 반환.
   */
  private async postForm(
    url: string,
    body: URLSearchParams,
  ): Promise<Response | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      this.logger.warn(
        `Apple POST ${url} network error: ${(err as Error).message}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
