import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as jose from 'jose';
import { AppleS2SService } from './apple-s2s.service';
import { User } from '../users/user.entity';
import { StorageUsageService } from '../myinfo/storage-usage.service';
import { FilesService } from '../files/files.service';
import { DiscordNotifier } from '../common/discord-notifier';
import { UserDeletionLog } from '../users/user-deletion-log.entity';

/**
 * AppleS2SService spec.
 *
 * 시나리오:
 *   1) verifyAndParse — 정상 · 서명 실패 · events 누락 · JSON 파싱 실패 · type/sub 누락 · empty payload
 *   2) handleNotification dispatch — account-delete / consent-revoked / email-disabled / email-enabled / unknown
 *   3) delete 정책 — Apple only 완전 삭제 / Kakao 병합 시 apple_sub 만 해제 / user 미존재 no-op
 *   4) R2 cleanup — 저장 파일 있을 때 deleteFile 호출
 */
jest.mock('jose', () => ({
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(() => jest.fn()),
}));

const mockedJwtVerify = jose.jwtVerify as jest.MockedFunction<
  typeof jose.jwtVerify
>;

describe('AppleS2SService', () => {
  let service: AppleS2SService;
  let userRepo: jest.Mocked<Repository<User>>;
  let storageUsage: jest.Mocked<StorageUsageService>;
  let filesService: jest.Mocked<FilesService>;

  const APPLE_BUNDLE_ID = 'com.chwippo.app';

  beforeEach(async () => {
    const mockRepo = mock<Repository<User>>();
    const mockStorage = mock<StorageUsageService>();
    const mockFiles = mock<FilesService>();
    mockStorage.collectAllFileUrls.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: DiscordNotifier,
          useValue: { notify: jest.fn().mockResolvedValue('sent') },
        },
        AppleS2SService,
        { provide: getRepositoryToken(User), useValue: mockRepo },
        {
          provide: getRepositoryToken(UserDeletionLog),
          useValue: { insert: jest.fn().mockResolvedValue({}) },
        },
        { provide: StorageUsageService, useValue: mockStorage },
        { provide: FilesService, useValue: mockFiles },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn((key: string) => {
              if (key === 'APPLE_BUNDLE_ID') return APPLE_BUNDLE_ID;
              throw new Error(`missing config: ${key}`);
            }),
          },
        },
      ],
    }).compile();

    service = module.get(AppleS2SService);
    userRepo = module.get(getRepositoryToken(User));
    storageUsage = module.get(StorageUsageService);
    filesService = module.get(FilesService);
  });

  afterEach(() => jest.clearAllMocks());

  const mockVerified = (eventsJson: string) => {
    mockedJwtVerify.mockResolvedValue({
      payload: {
        iss: 'https://appleid.apple.com',
        aud: APPLE_BUNDLE_ID,
        events: eventsJson,
      },
      protectedHeader: { alg: 'RS256' },
    } as never);
  };

  // ── verifyAndParse ────────────────────────────────────
  describe('verifyAndParse', () => {
    it('정상 → event 객체 반환', async () => {
      mockVerified(
        JSON.stringify({ type: 'account-delete', sub: 'apple-sub-1' }),
      );

      const event = await service.verifyAndParse('valid.jwt');

      expect(event.type).toBe('account-delete');
      expect(event.sub).toBe('apple-sub-1');
    });

    it('빈 payload → BadRequestException', async () => {
      await expect(service.verifyAndParse('')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockedJwtVerify).not.toHaveBeenCalled();
    });

    it('undefined payload → BadRequestException', async () => {
      await expect(
        service.verifyAndParse(undefined as unknown as string),
      ).rejects.toThrow(BadRequestException);
    });

    it('JWT 서명 실패 → UnauthorizedException', async () => {
      mockedJwtVerify.mockRejectedValue(new Error('signature invalid'));

      await expect(service.verifyAndParse('bad.jwt')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('events 필드 누락 → BadRequestException', async () => {
      mockedJwtVerify.mockResolvedValue({
        payload: {
          iss: 'https://appleid.apple.com',
          aud: APPLE_BUNDLE_ID,
        },
        protectedHeader: { alg: 'RS256' },
      } as never);

      await expect(service.verifyAndParse('valid.jwt')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('events JSON 파싱 실패 → BadRequestException', async () => {
      mockVerified('not-json-{{');

      await expect(service.verifyAndParse('valid.jwt')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('event.type 누락 → BadRequestException', async () => {
      mockVerified(JSON.stringify({ sub: 'apple-sub-1' }));

      await expect(service.verifyAndParse('valid.jwt')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('event.sub 누락 → BadRequestException', async () => {
      mockVerified(JSON.stringify({ type: 'account-delete' }));

      await expect(service.verifyAndParse('valid.jwt')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── handleNotification dispatch ─────────────────────
  describe('handleNotification', () => {
    it('account-delete · Apple only user → hard delete + R2 cascade', async () => {
      const user = {
        id: 'u-1',
        appleSub: 'sub-apple',
        appleEmail: null,
        kakaoId: null,
      } as User;
      userRepo.findOne.mockResolvedValue(user);
      userRepo.remove.mockResolvedValue(user);
      storageUsage.collectAllFileUrls.mockResolvedValue([
        'r2://a.pdf',
        'r2://b.jpg',
      ]);
      mockVerified(
        JSON.stringify({ type: 'account-delete', sub: 'sub-apple' }),
      );

      const result = await service.handleNotification('jwt');

      expect(result).toEqual({ action: 'deleted', userId: 'u-1' });
      expect(userRepo.remove).toHaveBeenCalledWith(user);
      expect(filesService.deleteFile).toHaveBeenCalledTimes(2);
    });

    it('consent-revoked · Apple only → hard delete', async () => {
      const user = {
        id: 'u-2',
        appleSub: 'sub-2',
        kakaoId: null,
      } as User;
      userRepo.findOne.mockResolvedValue(user);
      userRepo.remove.mockResolvedValue(user);
      mockVerified(JSON.stringify({ type: 'consent-revoked', sub: 'sub-2' }));

      const result = await service.handleNotification('jwt');

      expect(result).toEqual({ action: 'deleted', userId: 'u-2' });
    });

    it('account-delete · Kakao 병합 user → apple_sub 만 해제 (Kakao 유지)', async () => {
      const user = {
        id: 'u-3',
        appleSub: 'sub-3',
        appleEmail: 'foo@relay',
        kakaoId: 'kakao-1',
      } as User;
      userRepo.findOne.mockResolvedValue(user);
      userRepo.save.mockImplementation(async (u) => u as User);
      mockVerified(JSON.stringify({ type: 'account-delete', sub: 'sub-3' }));

      const result = await service.handleNotification('jwt');

      expect(result).toEqual({
        action: 'apple_unlinked',
        userId: 'u-3',
      });
      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          appleSub: null,
          appleEmail: null,
          kakaoId: 'kakao-1',
        }),
      );
      expect(userRepo.remove).not.toHaveBeenCalled();
    });

    it('account-delete · user 미존재 → user_not_found (no-op)', async () => {
      userRepo.findOne.mockResolvedValue(null);
      mockVerified(
        JSON.stringify({ type: 'account-delete', sub: 'sub-unknown' }),
      );

      const result = await service.handleNotification('jwt');

      expect(result).toEqual({
        action: 'user_not_found',
        sub: 'sub-unknown',
      });
      expect(userRepo.remove).not.toHaveBeenCalled();
      expect(userRepo.save).not.toHaveBeenCalled();
    });

    it('email-disabled → logged (DB 변경 없음)', async () => {
      mockVerified(JSON.stringify({ type: 'email-disabled', sub: 'sub-e' }));

      const result = await service.handleNotification('jwt');

      expect(result).toEqual({ action: 'logged', type: 'email-disabled' });
      expect(userRepo.findOne).not.toHaveBeenCalled();
    });

    it('email-enabled → logged', async () => {
      mockVerified(JSON.stringify({ type: 'email-enabled', sub: 'sub-e' }));

      const result = await service.handleNotification('jwt');

      expect(result).toEqual({ action: 'logged', type: 'email-enabled' });
    });

    it('알 수 없는 event type → logged (Apple 향후 확장 대비)', async () => {
      mockVerified(JSON.stringify({ type: 'some-new-event', sub: 'sub-x' }));

      const result = await service.handleNotification('jwt');

      expect(result.action).toBe('logged');
    });
  });
});
