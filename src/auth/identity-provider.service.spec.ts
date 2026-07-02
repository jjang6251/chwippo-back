import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IdentityProviderService } from './identity-provider.service';

/**
 * IdentityProviderService spec.
 *
 * 시나리오:
 *   1) unlinkKakao — admin key 미설정 / 정상 200 / 400·401 / 네트워크 오류
 *   2) revokeApple — 항상 false (stub) · 로그만
 *   3) POST 페이로드 검증 — Authorization header · target_id_type · target_id
 */
describe('IdentityProviderService', () => {
  let service: IdentityProviderService;
  let configService: jest.Mocked<ConfigService>;
  const originalFetch = global.fetch;

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
      ],
    }).compile();

    service = module.get(IdentityProviderService);
    configService = module.get(ConfigService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  // ── unlinkKakao ────────────────────────────────
  describe('unlinkKakao', () => {
    it('KAKAO_ADMIN_KEY 미설정 → false · fetch 미호출', async () => {
      configService.get.mockReturnValue(undefined);
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as never;

      const result = await service.unlinkKakao('kakao-1');

      expect(result).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('Kakao API 200 → true · Authorization / target_id 정확', async () => {
      configService.get.mockReturnValue('admin-key-abc');
      const fetchSpy = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });
      global.fetch = fetchSpy as never;

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
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
      }) as never;

      await expect(service.unlinkKakao('kakao-1')).resolves.toBe(false);
    });

    it('Kakao API 401 (admin key 무효) → false', async () => {
      configService.get.mockReturnValue('bad-key');
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
      }) as never;

      await expect(service.unlinkKakao('kakao-1')).resolves.toBe(false);
    });

    it('네트워크 오류 (fetch reject) → false · throw 안 함', async () => {
      configService.get.mockReturnValue('admin-key');
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('ECONNRESET')) as never;

      await expect(service.unlinkKakao('kakao-1')).resolves.toBe(false);
    });
  });

  // ── revokeApple ────────────────────────────────
  describe('revokeApple', () => {
    it('현재는 stub → 항상 false 반환 · throw 안 함', async () => {
      await expect(service.revokeApple('apple-sub-xyz')).resolves.toBe(false);
    });

    it('sub 값 길이 무관 (12자 미만도 안전)', async () => {
      await expect(service.revokeApple('short')).resolves.toBe(false);
    });
  });
});
