import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { mock } from 'jest-mock-extended';
import { QueryFailedError, Repository } from 'typeorm';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as jose from 'jose';
import {
  AppleAuthService,
  type AppleIdentityTokenPayload,
} from './apple-auth.service';
import { AppleTokenService } from './apple-token.service';
import { User } from '../users/user.entity';
import { DiscordNotifier } from '../common/discord-notifier';

/**
 * AppleAuthService spec.
 *
 * jwtVerify 는 jose 모듈 함수 자체를 spy · JWKS 네트워크 mock.
 * AppleTokenService(교환 헬퍼) 는 mock provider 로 주입 (exchangeCode·isConfigured).
 *
 * 시나리오:
 *   1) verifyIdentityToken — 정상 / iss mismatch / aud mismatch / expired / sub 누락 / 빈 문자열
 *                            / expectedAudience 기본값(BUNDLE) vs 명시(SERVICES) 전파
 *   2) extractUserInfo — email 있음 · 없음 · relay (private) · fullName 유무
 *   3) findOrCreateAppleUser — 신규 · 기존 · race 23505 · 다른 unique 에러 · nickname derive 3 케이스
 *   4) storeRefreshToken — userRepo.update 호출 (appleRefreshToken 저장)
 *   5) exchangeAndStoreRefreshToken (fire-and-forget best-effort)
 *      - isConfigured false → exchangeCode 미호출 · store 미호출
 *      - exchangeCode 성공 → storeRefreshToken(update) 호출
 *      - exchangeCode null(실패) → store 미호출
 *      - 내부 에러(exchangeCode throw) → throw 안 함 · store 미호출 (자체 흡수)
 */
// jose 는 ESM 전용 · Jest 는 CommonJS · 완전 mock (spec 은 jose 실제 로직에 의존 안 함)
// apple-token.service 가 SignJWT·importPKCS8 도 import 하므로 함께 mock (호출은 안 됨)
jest.mock('jose', () => ({
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(() => jest.fn()), // JWKS getter (getKey)
  SignJWT: jest.fn(),
  importPKCS8: jest.fn(),
}));

const mockedJwtVerify = jose.jwtVerify as jest.MockedFunction<
  typeof jose.jwtVerify
>;

describe('AppleAuthService', () => {
  let service: AppleAuthService;
  let userRepo: jest.Mocked<Repository<User>>;

  const APPLE_BUNDLE_ID = 'com.chwippo.app';
  const APPLE_SERVICES_ID = 'com.chwippo.web';

  const mockAppleTokenService = {
    isConfigured: jest.fn(),
    exchangeCode: jest.fn(),
  };

  beforeEach(async () => {
    const mockRepo = mock<Repository<User>>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: DiscordNotifier,
          useValue: { notify: jest.fn().mockResolvedValue('sent') },
        },
        AppleAuthService,
        { provide: getRepositoryToken(User), useValue: mockRepo },
        { provide: AppleTokenService, useValue: mockAppleTokenService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
            getOrThrow: jest.fn((key: string) => {
              if (key === 'APPLE_BUNDLE_ID') return APPLE_BUNDLE_ID;
              throw new Error(`missing config: ${key}`);
            }),
          },
        },
      ],
    }).compile();

    service = module.get(AppleAuthService);
    userRepo = module.get(getRepositoryToken(User));
  });

  afterEach(() => jest.clearAllMocks());

  // ─── verifyIdentityToken ────────────────────────────────
  describe('verifyIdentityToken', () => {
    const validPayload: AppleIdentityTokenPayload = {
      sub: 'apple-sub-abc',
      email: 'foo@example.com',
      aud: APPLE_BUNDLE_ID,
      iss: 'https://appleid.apple.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    };

    it('정상 → payload 반환 · sub · aud · iss 유지', async () => {
      mockedJwtVerify.mockResolvedValue({
        payload: validPayload,
        protectedHeader: { alg: 'RS256' },
      } as never);

      const result = await service.verifyIdentityToken('valid.jwt.token');

      expect(result.sub).toBe('apple-sub-abc');
      expect(result.aud).toBe(APPLE_BUNDLE_ID);
      expect(result.iss).toBe('https://appleid.apple.com');
      expect(mockedJwtVerify).toHaveBeenCalledWith(
        'valid.jwt.token',
        expect.anything(),
        {
          issuer: 'https://appleid.apple.com',
          audience: APPLE_BUNDLE_ID,
        },
      );
    });

    it('expectedAudience 기본값 = BUNDLE_ID (네이티브) — 명시 안 하면 config 값', async () => {
      mockedJwtVerify.mockResolvedValue({
        payload: validPayload,
        protectedHeader: { alg: 'RS256' },
      } as never);

      await service.verifyIdentityToken('valid.jwt.token');

      expect(mockedJwtVerify).toHaveBeenCalledWith(
        'valid.jwt.token',
        expect.anything(),
        expect.objectContaining({ audience: APPLE_BUNDLE_ID }),
      );
    });

    it('expectedAudience 명시(SERVICES_ID · 웹 SIWA) → jwtVerify 로 그대로 전파', async () => {
      mockedJwtVerify.mockResolvedValue({
        payload: { ...validPayload, aud: APPLE_SERVICES_ID },
        protectedHeader: { alg: 'RS256' },
      } as never);

      await service.verifyIdentityToken('valid.jwt.token', APPLE_SERVICES_ID);

      expect(mockedJwtVerify).toHaveBeenCalledWith(
        'valid.jwt.token',
        expect.anything(),
        expect.objectContaining({ audience: APPLE_SERVICES_ID }),
      );
    });

    it('빈 문자열 → BadRequestException', async () => {
      await expect(service.verifyIdentityToken('')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockedJwtVerify).not.toHaveBeenCalled();
    });

    it('undefined → BadRequestException', async () => {
      await expect(
        service.verifyIdentityToken(undefined as unknown as string),
      ).rejects.toThrow(BadRequestException);
    });

    it('jwtVerify 실패 (서명 불일치) → UnauthorizedException', async () => {
      mockedJwtVerify.mockRejectedValue(new Error('signature verify failed'));
      await expect(service.verifyIdentityToken('bad.token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('jwtVerify 실패 (iss mismatch) → UnauthorizedException', async () => {
      mockedJwtVerify.mockRejectedValue(
        new Error('unexpected "iss" claim value'),
      );
      await expect(service.verifyIdentityToken('bad')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('jwtVerify 실패 (aud mismatch) → UnauthorizedException', async () => {
      mockedJwtVerify.mockRejectedValue(
        new Error('unexpected "aud" claim value'),
      );
      await expect(service.verifyIdentityToken('bad')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('jwtVerify 실패 (expired) → UnauthorizedException', async () => {
      mockedJwtVerify.mockRejectedValue(
        new Error('"exp" claim timestamp check failed'),
      );
      await expect(service.verifyIdentityToken('expired')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('sub 누락 → BadRequestException', async () => {
      mockedJwtVerify.mockResolvedValue({
        payload: {
          ...validPayload,
          sub: undefined,
        } as unknown as AppleIdentityTokenPayload,
        protectedHeader: { alg: 'RS256' },
      } as never);

      await expect(
        service.verifyIdentityToken('malformed.token'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── extractUserInfo ──────────────────────────────────
  describe('extractUserInfo', () => {
    const basePayload: AppleIdentityTokenPayload = {
      sub: 'sub-1',
      aud: APPLE_BUNDLE_ID,
      iss: 'https://appleid.apple.com',
    };

    it('email · is_private_email boolean false → isPrivateEmail false', () => {
      const result = service.extractUserInfo({
        ...basePayload,
        email: 'user@test.com',
        is_private_email: false,
      });
      expect(result.appleSub).toBe('sub-1');
      expect(result.email).toBe('user@test.com');
      expect(result.isPrivateEmail).toBe(false);
    });

    it('is_private_email === "true" (string) → isPrivateEmail true', () => {
      const result = service.extractUserInfo({
        ...basePayload,
        email: 'foo@privaterelay.appleid.com',
        is_private_email: 'true',
      });
      expect(result.isPrivateEmail).toBe(true);
    });

    it('is_private_email === true (boolean) → isPrivateEmail true', () => {
      const result = service.extractUserInfo({
        ...basePayload,
        email: 'foo@privaterelay.appleid.com',
        is_private_email: true,
      });
      expect(result.isPrivateEmail).toBe(true);
    });

    it('email 없음 → null', () => {
      const result = service.extractUserInfo(basePayload);
      expect(result.email).toBeNull();
      expect(result.isPrivateEmail).toBe(false);
    });

    it('fullName 전달 시 그대로 보존', () => {
      const result = service.extractUserInfo(basePayload, {
        givenName: '길동',
        familyName: '홍',
      });
      expect(result.fullName).toEqual({ givenName: '길동', familyName: '홍' });
    });
  });

  // ─── findOrCreateAppleUser ────────────────────────────
  describe('findOrCreateAppleUser', () => {
    const info = {
      appleSub: 'sub-new',
      email: 'new@test.com',
      isPrivateEmail: false,
    };

    it('기존 사용자 → isNew=false · 그대로 반환', async () => {
      const existing = { id: 'u1', appleSub: 'sub-new' } as User;
      userRepo.findOne.mockResolvedValueOnce(existing);

      const result = await service.findOrCreateAppleUser(info);

      expect(result.isNew).toBe(false);
      expect(result.user).toBe(existing);
      expect(userRepo.save).not.toHaveBeenCalled();
    });

    it('신규 · fullName 있음 → 닉네임 = family+given', async () => {
      userRepo.findOne.mockResolvedValueOnce(null);
      userRepo.create.mockImplementation((data) => data as User);
      userRepo.save.mockImplementation(async (u) => u as User);

      const result = await service.findOrCreateAppleUser({
        ...info,
        fullName: { givenName: '길동', familyName: '홍' },
      });

      expect(result.isNew).toBe(true);
      expect(userRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          appleSub: 'sub-new',
          nickname: '홍길동',
          email: 'new@test.com',
          appleEmail: null,
        }),
      );
    });

    it('신규 · fullName 없음 · email 있음 (public) → 닉네임 = email prefix', async () => {
      userRepo.findOne.mockResolvedValueOnce(null);
      userRepo.create.mockImplementation((data) => data as User);
      userRepo.save.mockImplementation(async (u) => u as User);

      await service.findOrCreateAppleUser(info);

      expect(userRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ nickname: 'new' }),
      );
    });

    it('신규 · isPrivateEmail true → email=null · appleEmail 저장 · nickname = user_<sub앞8자>', async () => {
      userRepo.findOne.mockResolvedValueOnce(null);
      userRepo.create.mockImplementation((data) => data as User);
      userRepo.save.mockImplementation(async (u) => u as User);

      await service.findOrCreateAppleUser({
        appleSub: 'sub-abcdef1234567890',
        email: 'foo@privaterelay.appleid.com',
        isPrivateEmail: true,
      });

      expect(userRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: null,
          appleEmail: 'foo@privaterelay.appleid.com',
          nickname: 'user_sub-abcd',
        }),
      );
    });

    it('race 23505 (unique violation) → 기존 사용자 로 fallback', async () => {
      const raceUser = { id: 'u-race', appleSub: 'sub-new' } as User;
      userRepo.findOne
        .mockResolvedValueOnce(null) // 첫 lookup
        .mockResolvedValueOnce(raceUser); // race 후 재조회
      userRepo.create.mockImplementation((data) => data as User);
      const uniqueErr = new QueryFailedError('', [], new Error('duplicate'));
      (uniqueErr as unknown as { driverError: { code: string } }).driverError =
        { code: '23505' };
      userRepo.save.mockRejectedValueOnce(uniqueErr);

      const result = await service.findOrCreateAppleUser(info);

      expect(result.isNew).toBe(false);
      expect(result.user).toBe(raceUser);
    });

    it('다른 unique 에러 (23505 아님) → 원본 throw', async () => {
      userRepo.findOne.mockResolvedValueOnce(null);
      userRepo.create.mockImplementation((data) => data as User);
      const otherErr = new QueryFailedError('', [], new Error('fk violation'));
      (otherErr as unknown as { driverError: { code: string } }).driverError = {
        code: '23503',
      };
      userRepo.save.mockRejectedValueOnce(otherErr);

      await expect(service.findOrCreateAppleUser(info)).rejects.toThrow(
        QueryFailedError,
      );
    });

    it('race 후 재조회 조차 실패 (매우 드물게) → 원본 에러 throw', async () => {
      userRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      userRepo.create.mockImplementation((data) => data as User);
      const uniqueErr = new QueryFailedError('', [], new Error('duplicate'));
      (uniqueErr as unknown as { driverError: { code: string } }).driverError =
        { code: '23505' };
      userRepo.save.mockRejectedValueOnce(uniqueErr);

      await expect(service.findOrCreateAppleUser(info)).rejects.toThrow(
        QueryFailedError,
      );
    });
  });

  // ─── storeRefreshToken ────────────────────────────────
  describe('storeRefreshToken', () => {
    it('userRepo.update(userId, { appleRefreshToken }) 호출', async () => {
      userRepo.update.mockResolvedValue({ affected: 1 } as never);

      await service.storeRefreshToken('user-1', 'refresh-token-xyz');

      expect(userRepo.update).toHaveBeenCalledWith('user-1', {
        appleRefreshToken: 'refresh-token-xyz',
      });
    });
  });

  // ─── exchangeAndStoreRefreshToken (fire-and-forget best-effort) ─
  describe('exchangeAndStoreRefreshToken', () => {
    beforeEach(() => {
      userRepo.update.mockResolvedValue({ affected: 1 } as never);
    });

    it('isConfigured false → exchangeCode 미호출 · update 미호출', async () => {
      mockAppleTokenService.isConfigured.mockReturnValue(false);

      await service.exchangeAndStoreRefreshToken(
        'user-1',
        'auth-code',
        APPLE_BUNDLE_ID,
      );

      expect(mockAppleTokenService.exchangeCode).not.toHaveBeenCalled();
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('exchangeCode 성공 → storeRefreshToken(update) 호출', async () => {
      mockAppleTokenService.isConfigured.mockReturnValue(true);
      mockAppleTokenService.exchangeCode.mockResolvedValue('rt-from-apple');

      await service.exchangeAndStoreRefreshToken(
        'user-1',
        'auth-code',
        APPLE_BUNDLE_ID,
      );

      expect(mockAppleTokenService.exchangeCode).toHaveBeenCalledWith(
        'auth-code',
        APPLE_BUNDLE_ID,
        undefined,
      );
      expect(userRepo.update).toHaveBeenCalledWith('user-1', {
        appleRefreshToken: 'rt-from-apple',
      });
    });

    it('웹 경로 — redirectUri 를 exchangeCode 로 전파', async () => {
      mockAppleTokenService.isConfigured.mockReturnValue(true);
      mockAppleTokenService.exchangeCode.mockResolvedValue('rt-web');

      await service.exchangeAndStoreRefreshToken(
        'user-1',
        'auth-code',
        APPLE_SERVICES_ID,
        'https://chwippo.com/auth/apple/web/callback',
      );

      expect(mockAppleTokenService.exchangeCode).toHaveBeenCalledWith(
        'auth-code',
        APPLE_SERVICES_ID,
        'https://chwippo.com/auth/apple/web/callback',
      );
    });

    it('exchangeCode null(교환 실패) → update 미호출', async () => {
      mockAppleTokenService.isConfigured.mockReturnValue(true);
      mockAppleTokenService.exchangeCode.mockResolvedValue(null);

      await service.exchangeAndStoreRefreshToken(
        'user-1',
        'auth-code',
        APPLE_BUNDLE_ID,
      );

      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('내부 에러(exchangeCode throw) → throw 안 함 · update 미호출 (자체 흡수)', async () => {
      mockAppleTokenService.isConfigured.mockReturnValue(true);
      mockAppleTokenService.exchangeCode.mockRejectedValue(
        new Error('unexpected'),
      );

      await expect(
        service.exchangeAndStoreRefreshToken(
          'user-1',
          'auth-code',
          APPLE_BUNDLE_ID,
        ),
      ).resolves.toBeUndefined();
      expect(userRepo.update).not.toHaveBeenCalled();
    });
  });
});
