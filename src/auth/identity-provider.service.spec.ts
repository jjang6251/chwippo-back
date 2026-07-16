import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IdentityProviderService } from './identity-provider.service';
import { AppleTokenService } from './apple-token.service';

/**
 * IdentityProviderService spec.
 *
 * 탈퇴 시 프로바이더 측 정리 헬퍼 — 모두 best-effort(throw X · 로컬 삭제 계속).
 * jose 는 AppleTokenService import 체인 때문에 로드되므로 mock (실 로직 미사용).
 *
 * 검증할 경우의 수:
 *   [unlinkKakao]
 *     - ADMIN_KEY 미설정 → false · fetch 미호출 (스킵)
 *     - 200 → true · Authorization/target_id body 정확 (정상)
 *     - 400(이미 unlink) / 401(무효 키) → false (실패 · throw X)
 *     - 네트워크 오류 → false (실패 · throw X)
 *   [revokeApple] — appleTokenService.revoke 위임
 *     - refresh_token null → revoke 미호출 · isConfigured 미확인 · false (스킵/멱등)
 *     - isConfigured false → revoke 미호출 · false (미설정 스킵)
 *     - BUNDLE_ID revoke 성공 → true · SERVICES_ID 재시도 안 함 (정상)
 *     - BUNDLE_ID 실패 → SERVICES_ID 재시도 성공 → true (경계)
 *     - 둘 다 실패 → false · throw X (탈퇴 계속)
 *     - SERVICES_ID 미설정 → BUNDLE_ID 만 시도 (경계)
 *     - revoke 는 전달받은 refresh_token·client_id 그대로 위임 (본인 스코프 · 인자 전파)
 */
jest.mock('jose', () => ({
  SignJWT: jest.fn(),
  importPKCS8: jest.fn(),
}));

const APPLE_BUNDLE_ID = 'com.chwippo.app';
const APPLE_SERVICES_ID = 'com.chwippo.web';
const APPLE_REFRESH_TOKEN = 'apple-refresh-token-abc';
const APPLE_SUB = 'apple-sub-0123456789abcdef';

describe('IdentityProviderService', () => {
  let service: IdentityProviderService;
  let configService: jest.Mocked<ConfigService>;
  const originalFetch = global.fetch;

  const mockAppleTokenService = {
    isConfigured: jest.fn(),
    revoke: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdentityProviderService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: AppleTokenService,
          useValue: mockAppleTokenService,
        },
      ],
    }).compile();

    service = module.get(IdentityProviderService);
    configService = module.get(ConfigService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  /**
   * revokeApple 이 읽는 BUNDLE_ID·SERVICES_ID 를 세팅하는 config.get 구현.
   * ⚠️ 기본값 사용 금지 — configureAppleIds(undefined) 로 SERVICES_ID 미설정을 명시해야 하므로
   *    default param 을 두면 undefined 전달 시 default 로 되돌아가는 함정.
   */
  function configureAppleIds(servicesId: string | undefined): void {
    configService.get.mockImplementation((key: string) => {
      if (key === 'APPLE_BUNDLE_ID') return APPLE_BUNDLE_ID;
      if (key === 'APPLE_SERVICES_ID') return servicesId;
      return undefined;
    });
  }

  // ── unlinkKakao ────────────────────────────────
  describe('unlinkKakao', () => {
    it('KAKAO_ADMIN_KEY 미설정 → false · fetch 미호출', async () => {
      configService.get.mockReturnValue(undefined);
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy;

      const result = await service.unlinkKakao('kakao-1');

      expect(result).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('Kakao API 200 → true · Authorization / target_id 정확', async () => {
      configService.get.mockReturnValue('admin-key-abc');
      const fetchSpy = jest.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchSpy;

      const result = await service.unlinkKakao('kakao-123');

      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://kapi.kakao.com/v1/user/unlink',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'KakaoAK admin-key-abc',
            'Content-Type': 'application/x-www-form-urlencoded',
          }),
          body: 'target_id_type=user_id&target_id=kakao-123',
        }),
      );
    });

    it('Kakao API 400 (이미 unlink 됨) → false · throw 안 함', async () => {
      configService.get.mockReturnValue('admin-key');
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400 });

      await expect(service.unlinkKakao('kakao-1')).resolves.toBe(false);
    });

    it('Kakao API 401 (admin key 무효) → false', async () => {
      configService.get.mockReturnValue('bad-key');
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });

      await expect(service.unlinkKakao('kakao-1')).resolves.toBe(false);
    });

    it('네트워크 오류 (fetch reject) → false · throw 안 함', async () => {
      configService.get.mockReturnValue('admin-key');
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

      await expect(service.unlinkKakao('kakao-1')).resolves.toBe(false);
    });
  });

  // ── revokeApple ────────────────────────────────
  describe('revokeApple', () => {
    it('refresh_token null → revoke 미호출 · isConfigured 미확인 · false (스킵/멱등)', async () => {
      configureAppleIds(APPLE_SERVICES_ID);

      const result = await service.revokeApple(null, APPLE_SUB);

      expect(result).toBe(false);
      expect(mockAppleTokenService.isConfigured).not.toHaveBeenCalled();
      expect(mockAppleTokenService.revoke).not.toHaveBeenCalled();
    });

    it('isConfigured false (.p8 미설정) → revoke 미호출 · false', async () => {
      configureAppleIds(APPLE_SERVICES_ID);
      mockAppleTokenService.isConfigured.mockReturnValue(false);

      const result = await service.revokeApple(APPLE_REFRESH_TOKEN, APPLE_SUB);

      expect(result).toBe(false);
      expect(mockAppleTokenService.revoke).not.toHaveBeenCalled();
    });

    it('BUNDLE_ID revoke 성공 → true · SERVICES_ID 재시도 안 함', async () => {
      configureAppleIds(APPLE_SERVICES_ID);
      mockAppleTokenService.isConfigured.mockReturnValue(true);
      mockAppleTokenService.revoke.mockResolvedValueOnce(true);

      const result = await service.revokeApple(APPLE_REFRESH_TOKEN, APPLE_SUB);

      expect(result).toBe(true);
      expect(mockAppleTokenService.revoke).toHaveBeenCalledTimes(1);
      expect(mockAppleTokenService.revoke).toHaveBeenCalledWith(
        APPLE_REFRESH_TOKEN,
        APPLE_BUNDLE_ID,
      );
    });

    it('BUNDLE_ID 실패 → SERVICES_ID 재시도 → 성공 시 true', async () => {
      configureAppleIds(APPLE_SERVICES_ID);
      mockAppleTokenService.isConfigured.mockReturnValue(true);
      mockAppleTokenService.revoke
        .mockResolvedValueOnce(false) // BUNDLE_ID
        .mockResolvedValueOnce(true); // SERVICES_ID

      const result = await service.revokeApple(APPLE_REFRESH_TOKEN, APPLE_SUB);

      expect(result).toBe(true);
      expect(mockAppleTokenService.revoke).toHaveBeenCalledTimes(2);
      expect(mockAppleTokenService.revoke).toHaveBeenNthCalledWith(
        1,
        APPLE_REFRESH_TOKEN,
        APPLE_BUNDLE_ID,
      );
      expect(mockAppleTokenService.revoke).toHaveBeenNthCalledWith(
        2,
        APPLE_REFRESH_TOKEN,
        APPLE_SERVICES_ID,
      );
    });

    it('둘 다 실패 → false · throw 안 함 (탈퇴 계속)', async () => {
      configureAppleIds(APPLE_SERVICES_ID);
      mockAppleTokenService.isConfigured.mockReturnValue(true);
      mockAppleTokenService.revoke.mockResolvedValue(false);

      const result = await service.revokeApple(APPLE_REFRESH_TOKEN, APPLE_SUB);

      expect(result).toBe(false);
      expect(mockAppleTokenService.revoke).toHaveBeenCalledTimes(2);
    });

    it('SERVICES_ID 미설정 → BUNDLE_ID 만 시도', async () => {
      configureAppleIds(undefined);
      mockAppleTokenService.isConfigured.mockReturnValue(true);
      mockAppleTokenService.revoke.mockResolvedValue(false);

      const result = await service.revokeApple(APPLE_REFRESH_TOKEN, APPLE_SUB);

      expect(result).toBe(false);
      expect(mockAppleTokenService.revoke).toHaveBeenCalledTimes(1);
      expect(mockAppleTokenService.revoke).toHaveBeenCalledWith(
        APPLE_REFRESH_TOKEN,
        APPLE_BUNDLE_ID,
      );
    });
  });
});
