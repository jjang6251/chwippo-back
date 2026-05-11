import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { FilesService } from './files.service';

// jest.mock 팩토리에서 외부 변수 참조 금지 (hoisting으로 인한 초기화 순서 문제)
// 대신 클래스/함수를 자동 mock 후 beforeEach에서 구현체 주입
jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/s3-request-presigner');

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
                  AWS_REGION: 'ap-northeast-2',
                  AWS_S3_BUCKET: 'chwippo',
                  AWS_ACCESS_KEY_ID: 'test-key-id',
                  AWS_SECRET_ACCESS_KEY: 'test-secret',
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

  // ── createPresignedUrl ─────────────────────────────────
  describe('createPresignedUrl', () => {
    it('image/jpeg → 통과, uploadUrl과 fileUrl 반환', async () => {
      const result = await service.createPresignedUrl(
        'user-uuid-1',
        'myinfo/language-cert',
        'image/jpeg',
        1024,
      );

      expect(result.uploadUrl).toBeDefined();
      expect(result.fileUrl).toContain(
        'users/user-uuid-1/myinfo/language-cert/',
      );
      expect(result.fileUrl).toContain('.jpg');
    });

    it('image/png → .png 확장자로 S3 key 생성', async () => {
      const result = await service.createPresignedUrl(
        'user-uuid-1',
        'myinfo/cert',
        'image/png',
        512,
      );
      expect(result.fileUrl).toContain('.png');
    });

    it('application/pdf → .pdf 확장자로 S3 key 생성', async () => {
      const result = await service.createPresignedUrl(
        'user-uuid-1',
        'myinfo/award',
        'application/pdf',
        2048,
      );
      expect(result.fileUrl).toContain('.pdf');
    });

    it('허용되지 않는 contentType(text/plain) → BadRequestException', async () => {
      await expect(
        service.createPresignedUrl(
          'user-uuid-1',
          'myinfo/cert',
          'text/plain',
          1024,
        ),
      ).rejects.toThrow(
        new BadRequestException(
          '허용되지 않는 파일 형식입니다. PDF, JPG, PNG만 가능합니다.',
        ),
      );
    });

    it('허용되지 않는 contentType(video/mp4) → BadRequestException', async () => {
      await expect(
        service.createPresignedUrl(
          'user-uuid-1',
          'myinfo/cert',
          'video/mp4',
          1024,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('fileSize = 10MB + 1 → BadRequestException', async () => {
      await expect(
        service.createPresignedUrl(
          'user-uuid-1',
          'myinfo/cert',
          'image/jpeg',
          10 * 1024 * 1024 + 1,
        ),
      ).rejects.toThrow(
        new BadRequestException('파일 크기는 10MB 이하여야 합니다.'),
      );
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

    it('S3 key 구조: users/{userId}/{scope}/{uuid}.{ext}', async () => {
      const result = await service.createPresignedUrl(
        'user-abc',
        'myinfo/language-cert',
        'application/pdf',
        100,
      );
      expect(result.fileUrl).toMatch(
        /^https:\/\/chwippo\.s3\.ap-northeast-2\.amazonaws\.com\/users\/user-abc\/myinfo\/language-cert\/[a-f0-9-]+\.pdf$/,
      );
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

    it('getSignedUrl에 expiresIn: 300 전달', async () => {
      await service.createPresignedUrl(
        'user-uuid-1',
        'myinfo/cert',
        'image/jpeg',
        1024,
      );

      expect(getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 300 },
      );
    });

    it('fileSize = 0 (경계값) → 통과', async () => {
      await expect(
        service.createPresignedUrl(
          'user-uuid-1',
          'myinfo/cert',
          'image/jpeg',
          0,
        ),
      ).resolves.toBeDefined();
    });
  });

  // ── deleteFile ─────────────────────────────────────────
  describe('deleteFile', () => {
    it('URL에서 올바른 key를 추출해 DeleteObjectCommand에 전달', async () => {
      const fileUrl =
        'https://chwippo.s3.ap-northeast-2.amazonaws.com/users/user-uuid-1/myinfo/cert/abc-123.pdf';

      await service.deleteFile(fileUrl);

      expect(DeleteObjectCommand).toHaveBeenCalledWith({
        Bucket: 'chwippo',
        Key: 'users/user-uuid-1/myinfo/cert/abc-123.pdf',
      });
      expect(mockS3Send).toHaveBeenCalled();
    });

    it('URL에서 leading slash가 제거된 key로 호출', async () => {
      const fileUrl =
        'https://chwippo.s3.ap-northeast-2.amazonaws.com/some/path/file.jpg';

      await service.deleteFile(fileUrl);

      const callArg = (DeleteObjectCommand as jest.Mock).mock.calls[0][0];
      expect(callArg.Key).toBe('some/path/file.jpg');
      expect(callArg.Key).not.toMatch(/^\//);
    });

    it('S3 send 실패 시 에러가 호출자로 전파됨', async () => {
      mockS3Send.mockRejectedValue(new Error('S3 NoSuchBucket'));

      await expect(
        service.deleteFile(
          'https://chwippo.s3.ap-northeast-2.amazonaws.com/users/u1/file.pdf',
        ),
      ).rejects.toThrow('S3 NoSuchBucket');
    });
  });
});
