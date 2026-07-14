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
    // jest.mock 로 auto-mock 된 SDK 커맨드 클래스. 실제 인스턴스 대신 args 를 담은
    // sentinel 객체를 반환하므로(모킹된 S3Client.send 가 소비), 커맨드 반환 타입을
    // 강제하는 jest.mocked() 대신 jest.Mock 으로 캐스팅한다.
    (PutObjectCommand as unknown as jest.Mock).mockImplementation((args) => ({
      ...args,
      _type: 'PutObjectCommand',
    }));
    (DeleteObjectCommand as unknown as jest.Mock).mockImplementation(
      (args) => ({
        ...args,
        _type: 'DeleteObjectCommand',
      }),
    );
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

    it('publicUrl prefix 안 맞는 외부 URL → ForbiddenException (assertOwnFileUrl 통합)', async () => {
      // PR F 후: prefix mismatch도 본인 파일 아님으로 분류 → Forbidden
      await expect(
        service.deleteOwnFile('u1', 'https://evil.com/users/u1/cert.pdf'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('빈 fileUrl → BadRequestException', async () => {
      await expect(service.deleteOwnFile('u1', '')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── assertOwnFileUrl (LRR P1T2 M-2 — myinfo·deleteOwnFile 공통 헬퍼) ─────
  describe('assertOwnFileUrl — ownership 검증', () => {
    it('본인 prefix → 통과 (예외 없음)', () => {
      expect(() =>
        service.assertOwnFileUrl(
          'u1',
          `${R2_PUBLIC}/users/u1/myinfo/cert/x.pdf`,
        ),
      ).not.toThrow();
    });

    it('다른 사용자 prefix → ForbiddenException (cross-user attach 차단)', () => {
      expect(() =>
        service.assertOwnFileUrl(
          'u1',
          `${R2_PUBLIC}/users/u2/myinfo/cert/x.pdf`,
        ),
      ).toThrow(ForbiddenException);
    });

    it('userId substring 우회 시도 (u1 prefix가 u11에 매치되지 않음)', () => {
      expect(() =>
        service.assertOwnFileUrl(
          'u1',
          `${R2_PUBLIC}/users/u11/myinfo/cert/x.pdf`,
        ),
      ).toThrow(ForbiddenException);
    });

    // M-25 (F2-11): URL encoding 우회 시도 — `%2F`로 path separator 우회 가능?
    it('M-25: URL-encoded `/` (%2F) 우회 시도 → 차단 (prefix string match 그대로)', () => {
      // attacker: `${R2_PUBLIC}/users/u2%2Fmyinfo/...` — u2를 자신처럼 보이게 시도
      expect(() =>
        service.assertOwnFileUrl(
          'u1',
          `${R2_PUBLIC}/users/u2%2Fmyinfo/cert/x.pdf`,
        ),
      ).toThrow(ForbiddenException);
    });

    it('M-25: URL-encoded `..` (%2E%2E) — user 자신 prefix 안에 있으면 통과 (S3 key 리터럴 보관, 디코딩 안 함)', () => {
      // %2E%2E는 `..`이지만 S3는 key를 normalize하지 않고 리터럴로 보관 →
      // `users/u1/%2E%2E/u2/cert/x.pdf`는 그저 이상한 키일 뿐 다른 사용자 파일 접근 불가.
      // ownership 검증의 의도는 "본인 prefix 시작"인데 이 URL은 본인 prefix로 시작하므로 통과 — 안전.
      expect(() =>
        service.assertOwnFileUrl(
          'u1',
          `${R2_PUBLIC}/users/u1/%2E%2E/u2/cert/x.pdf`,
        ),
      ).not.toThrow();
    });

    it('빈 fileUrl → BadRequestException', () => {
      expect(() => service.assertOwnFileUrl('u1', '')).toThrow(
        BadRequestException,
      );
    });

    it('publicUrlPrefix 미설정 (dev 환경) → silently skip', async () => {
      const noPrefixModule: TestingModule = await Test.createTestingModule({
        providers: [
          FilesService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string) => {
                if (key === 'R2_PUBLIC_URL') return '';
                if (key === 'R2_BUCKET') return 'chwippo';
                if (key === 'NODE_ENV') return 'development';
                return '';
              }),
            },
          },
        ],
      }).compile();
      const noPrefixService = noPrefixModule.get(FilesService);
      // 빈 publicUrlPrefix → skip (가드가 dev 사용 막지 않음)
      expect(() =>
        noPrefixService.assertOwnFileUrl('u1', 'https://anywhere.com/x.pdf'),
      ).not.toThrow();
    });
  });

  // LRR P2T1 PR M (C-1) — 운영에서 publicUrlPrefix 누락 시 constructor fail-fast
  describe('constructor — prod fail-fast (LRR P2T1 PR M C-1)', () => {
    it('NODE_ENV=production + R2_PUBLIC_URL 빈 값 → constructor throw', async () => {
      const buildModule = () =>
        Test.createTestingModule({
          providers: [
            FilesService,
            {
              provide: ConfigService,
              useValue: {
                get: jest.fn((key: string, defaultVal?: string) => {
                  if (key === 'R2_PUBLIC_URL') return '';
                  if (key === 'NODE_ENV') return 'production';
                  if (key === 'R2_BUCKET') return 'chwippo';
                  return defaultVal ?? '';
                }),
              },
            },
          ],
        }).compile();

      await expect(buildModule()).rejects.toThrow(/R2_PUBLIC_URL is required/);
    });

    it('NODE_ENV=production + R2_PUBLIC_URL 유효 값 → 정상 부팅', async () => {
      const okModule = await Test.createTestingModule({
        providers: [
          FilesService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultVal?: string) => {
                if (key === 'R2_PUBLIC_URL')
                  return 'https://files-prod.example.com';
                if (key === 'NODE_ENV') return 'production';
                if (key === 'R2_BUCKET') return 'chwippo-prod';
                return defaultVal ?? '';
              }),
            },
          },
        ],
      }).compile();
      const okService = okModule.get(FilesService);
      expect(okService).toBeDefined();
    });

    it('NODE_ENV=development + R2_PUBLIC_URL 빈 값 → 정상 부팅 (dev 편의)', async () => {
      const devModule = await Test.createTestingModule({
        providers: [
          FilesService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultVal?: string) => {
                if (key === 'R2_PUBLIC_URL') return '';
                if (key === 'NODE_ENV') return 'development';
                return defaultVal ?? '';
              }),
            },
          },
        ],
      }).compile();
      const devService = devModule.get(FilesService);
      expect(devService).toBeDefined();
    });
  });
});
