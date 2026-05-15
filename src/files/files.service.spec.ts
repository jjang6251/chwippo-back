import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { FilesService } from './files.service';

// jest.mock 팩토리에서 외부 변수 참조 금지 (hoisting 이슈)
jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/s3-request-presigner');

const R2_PUBLIC = 'https://pub-test.r2.dev';

describe('FilesService', () => {
  let service: FilesService;
  let mockS3Send: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockS3Send = jest.fn().mockResolvedValue({});
    (S3Client as jest.Mock).mockImplementation(() => ({ send: mockS3Send }));
    (PutObjectCommand as jest.Mock).mockImplementation((args) => ({
      ...args,
      _type: 'PutObjectCommand',
    }));
    (DeleteObjectCommand as jest.Mock).mockImplementation((args) => ({
      ...args,
      _type: 'DeleteObjectCommand',
    }));
    (getSignedUrl as jest.Mock).mockResolvedValue(
      'https://presigned.example.com/key?sig=abc',
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FilesService,
        {
          provide: ConfigService,
          useValue: {
            get: jest
              .fn()
              .mockImplementation((key: string, defaultVal?: string) => {
                const map: Record<string, string> = {
                  R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
                  R2_BUCKET: 'chwippo',
                  R2_ACCESS_KEY_ID: 'test-key-id',
                  R2_SECRET_ACCESS_KEY: 'test-secret',
                  R2_PUBLIC_URL: R2_PUBLIC,
                };
                return map[key] ?? defaultVal ?? '';
              }),
            getOrThrow: jest.fn().mockReturnValue(''),
          },
        },
      ],
    }).compile();

    service = module.get<FilesService>(FilesService);
  });

  // ── createPresignedUrl — 성공 흐름 ─────────────────────
  describe('createPresignedUrl — 성공', () => {
    it('image/jpeg + 유효한 scope → uploadUrl/fileUrl 반환, fileUrl 형식 정확', async () => {
      const result = await service.createPresignedUrl(
        'user-uuid-1',
        'myinfo/language-cert',
        'image/jpeg',
        1024,
      );
      expect(result.uploadUrl).toBeDefined();
      expect(result.fileUrl).toMatch(
        new RegExp(
          `^${R2_PUBLIC}/users/user-uuid-1/myinfo/language-cert/[a-f0-9-]+\\.jpg$`,
        ),
      );
    });

    it('image/png → .png 확장자', async () => {
      const result = await service.createPresignedUrl(
        'user-uuid-1',
        'myinfo/cert',
        'image/png',
        512,
      );
      expect(result.fileUrl).toMatch(/\.png$/);
    });

    it('application/pdf → .pdf 확장자', async () => {
      const result = await service.createPresignedUrl(
        'user-uuid-1',
        'myinfo/award',
        'application/pdf',
        2048,
      );
      expect(result.fileUrl).toMatch(/\.pdf$/);
    });

    it('fileSize = 10MB (경계값) → 통과', async () => {
      await expect(
        service.createPresignedUrl(
          'user-uuid-1',
          'myinfo/cert',
          'image/jpeg',
          10 * 1024 * 1024,
        ),
      ).resolves.toBeDefined();
    });

    it('PutObjectCommand에 올바른 파라미터 전달', async () => {
      await service.createPresignedUrl(
        'user-uuid-1',
        'myinfo/cert',
        'image/jpeg',
        1024,
      );
      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Bucket: 'chwippo',
          ContentType: 'image/jpeg',
          ContentLength: 1024,
        }),
      );
    });

    it('S3 key 구조: users/{userId}/{scope}/{uuid}.{ext} (IDOR 방지)', async () => {
      const result = await service.createPresignedUrl(
        'user-abc',
        'myinfo/language-cert',
        'application/pdf',
        100,
      );
      expect(result.fileUrl).toContain('users/user-abc/myinfo/language-cert/');
    });

    it('getSignedUrl에 expiresIn: 300 (5분) 전달', async () => {
      await service.createPresignedUrl(
        'user-uuid-1',
        'myinfo/cert',
        'image/jpeg',
        1024,
      );
      expect(getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        {
          expiresIn: 300,
        },
      );
    });
  });

  // ── createPresignedUrl — scope 검증 (FB-8, FB-10, S-5, S-6) ─
  describe('createPresignedUrl — scope 화이트리스트', () => {
    it.each([
      ['admin/audit'],
      ['users/other-user/cert'],
      ['../etc/passwd'],
      ['myinfo/../admin'],
      [''],
      ['myinfo/unknown-section'],
    ])('허용되지 않은 scope "%s" → BadRequestException', async (scope) => {
      await expect(
        service.createPresignedUrl('user-1', scope, 'image/jpeg', 1024),
      ).rejects.toThrow(BadRequestException);
    });

    it.each([
      ['myinfo/cert'],
      ['myinfo/award'],
      ['myinfo/language-cert'],
      ['myinfo/document'],
      ['myinfo/education'],
    ])('허용된 scope "%s" → 통과', async (scope) => {
      await expect(
        service.createPresignedUrl('user-1', scope, 'image/jpeg', 1024),
      ).resolves.toBeDefined();
    });
  });

  // ── createPresignedUrl — contentType / fileSize ───────
  describe('createPresignedUrl — contentType·fileSize 검증', () => {
    it('text/plain → BadRequestException', async () => {
      await expect(
        service.createPresignedUrl('u1', 'myinfo/cert', 'text/plain', 1024),
      ).rejects.toThrow(BadRequestException);
    });

    it('image/svg+xml (XSS 위험) → BadRequestException', async () => {
      await expect(
        service.createPresignedUrl('u1', 'myinfo/cert', 'image/svg+xml', 1024),
      ).rejects.toThrow(BadRequestException);
    });

    it('fileSize 0 → BadRequestException (FB-5)', async () => {
      await expect(
        service.createPresignedUrl('u1', 'myinfo/cert', 'image/jpeg', 0),
      ).rejects.toThrow(BadRequestException);
    });

    it('fileSize 음수 → BadRequestException', async () => {
      await expect(
        service.createPresignedUrl('u1', 'myinfo/cert', 'image/jpeg', -1),
      ).rejects.toThrow(BadRequestException);
    });

    it('fileSize > 10MB → BadRequestException', async () => {
      await expect(
        service.createPresignedUrl(
          'u1',
          'myinfo/cert',
          'image/jpeg',
          10 * 1024 * 1024 + 1,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── deleteFile ─────────────────────────────────────────
  describe('deleteFile', () => {
    it('R2 publicUrl prefix 기반 fileUrl → 올바른 Key 추출 후 DeleteObjectCommand 호출', async () => {
      const fileUrl = `${R2_PUBLIC}/users/u1/myinfo/cert/abc-123.pdf`;
      await service.deleteFile(fileUrl);
      expect(DeleteObjectCommand).toHaveBeenCalledWith({
        Bucket: 'chwippo',
        Key: 'users/u1/myinfo/cert/abc-123.pdf',
      });
      expect(mockS3Send).toHaveBeenCalled();
    });

    it('S3 send 실패해도 throw 하지 않음 (best-effort, FI-5)', async () => {
      mockS3Send.mockRejectedValue(new Error('R2 NoSuchKey'));
      await expect(
        service.deleteFile(`${R2_PUBLIC}/users/u1/file.pdf`),
      ).resolves.toBeUndefined();
    });

    it('빈 URL 입력 → no-op (예외 없이 반환)', async () => {
      await expect(service.deleteFile('')).resolves.toBeUndefined();
      expect(mockS3Send).not.toHaveBeenCalled();
    });
  });

  // ── deleteOwnFile (권한 검증 + 보상 cleanup용) ───────────
  describe('deleteOwnFile — 권한 검증', () => {
    it('본인 userId 일치 → DeleteObjectCommand 호출', async () => {
      const fileUrl = `${R2_PUBLIC}/users/u1/myinfo/cert/abc.pdf`;
      await service.deleteOwnFile('u1', fileUrl);
      expect(DeleteObjectCommand).toHaveBeenCalledWith({
        Bucket: 'chwippo',
        Key: 'users/u1/myinfo/cert/abc.pdf',
      });
    });

    it('다른 사용자 파일 삭제 시도 → ForbiddenException (S-2 강화)', async () => {
      const fileUrl = `${R2_PUBLIC}/users/u_other/myinfo/cert/abc.pdf`;
      await expect(service.deleteOwnFile('u1', fileUrl)).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('admin/audit 같은 다른 경로 시도 → ForbiddenException', async () => {
      const fileUrl = `${R2_PUBLIC}/admin/audit/secrets.pdf`;
      await expect(service.deleteOwnFile('u1', fileUrl)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('publicUrl prefix 안 맞는 외부 URL → BadRequestException', async () => {
      await expect(
        service.deleteOwnFile('u1', 'https://evil.com/users/u1/cert.pdf'),
      ).rejects.toThrow(BadRequestException);
    });

    it('빈 fileUrl → BadRequestException', async () => {
      await expect(service.deleteOwnFile('u1', '')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
