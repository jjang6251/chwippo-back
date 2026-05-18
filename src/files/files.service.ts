import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { isAllowedScope } from './scope.const';

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};
const MAX_BYTES = 10 * 1024 * 1024; // 10MB

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicUrlPrefix: string;

  constructor(private readonly config: ConfigService) {
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: config.get('R2_ENDPOINT', ''),
      credentials: {
        accessKeyId: config.get('R2_ACCESS_KEY_ID', ''),
        secretAccessKey: config.get('R2_SECRET_ACCESS_KEY', ''),
      },
    });
    this.bucket = config.get<string>('R2_BUCKET', 'chwippo');
    // 끝에 / 있으면 제거 — 키 결합 시 // 방지
    const publicUrl = config.get<string>('R2_PUBLIC_URL', '');
    this.publicUrlPrefix = publicUrl.replace(/\/$/, '');

    // LRR P2T1 PR M (C-1) — 운영에서 publicUrlPrefix 빈 값이면 즉시 부팅 실패.
    // env.validation이 1차 차단(Joi when NODE_ENV)이지만 우회·로딩 실수 대비 defense-in-depth.
    // 빈 값이면 assertOwnFileUrl가 silently skip → 모든 ownership 검증 무력화 (cross-user 파일 접근 가능).
    if (
      config.get<string>('NODE_ENV') === 'production' &&
      !this.publicUrlPrefix
    ) {
      throw new Error(
        'FilesService: R2_PUBLIC_URL is required in production for file ownership validation. ' +
          'env validation should have caught this — failing fast as defense-in-depth.',
      );
    }
  }

  async createPresignedUrl(
    userId: string,
    scope: string,
    contentType: string,
    fileSize: number,
  ): Promise<{ uploadUrl: string; fileUrl: string }> {
    // scope 화이트리스트 검증 — path injection·권한 우회 차단
    if (!isAllowedScope(scope)) {
      throw new BadRequestException('허용되지 않는 scope입니다.');
    }

    if (!ALLOWED_TYPES[contentType]) {
      throw new BadRequestException(
        '허용되지 않는 파일 형식입니다. PDF, JPG, PNG만 가능합니다.',
      );
    }
    if (fileSize <= 0 || fileSize > MAX_BYTES) {
      throw new BadRequestException(
        '파일 크기는 1B 이상 10MB 이하여야 합니다.',
      );
    }

    const ext = ALLOWED_TYPES[contentType];
    const key = `users/${userId}/${scope}/${uuidv4()}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: fileSize,
    });

    const uploadUrl = await getSignedUrl(this.s3, command, { expiresIn: 300 });
    const fileUrl = `${this.publicUrlPrefix}/${key}`;

    return { uploadUrl, fileUrl };
  }

  /**
   * fileUrl이 본인 R2 prefix (`{publicUrl}/users/{userId}/`)로 시작하는지 검증.
   * - dev에서 R2_PUBLIC_URL 미설정 (publicUrlPrefix 빈 값) → skip (가드가 dev 사용 막지 않음)
   * - prod는 1차 env.validation에서 required (Joi when NODE_ENV) + 2차 constructor에서 fail-fast (PR M C-1)
   *   → 여기 도달한 시점엔 prod면 반드시 publicUrlPrefix 있음. 빈 값이면 dev 환경 확정.
   *
   * LRR P1T2 M-2: myinfo CRUD에서 다른 사용자 파일 URL attach 차단용.
   * deleteOwnFile에서도 동일 검증 재사용.
   */
  assertOwnFileUrl(userId: string, fileUrl: string): void {
    if (!fileUrl) {
      throw new BadRequestException('fileUrl이 필요합니다.');
    }
    if (!this.publicUrlPrefix) {
      // dev R2 미설정 — silently skip
      return;
    }
    const expectedPrefix = `${this.publicUrlPrefix}/users/${userId}/`;
    if (!fileUrl.startsWith(expectedPrefix)) {
      throw new ForbiddenException(
        '본인이 업로드한 파일만 사용할 수 있습니다.',
      );
    }
  }

  /**
   * 본인이 업로드한 파일만 R2에서 삭제.
   * ValidationPipe 거부 등 컨트롤러 진입 전 실패한 경우 프론트가 보상 호출.
   */
  async deleteOwnFile(userId: string, fileUrl: string): Promise<void> {
    this.assertOwnFileUrl(userId, fileUrl);
    await this.deleteFile(fileUrl);
  }

  /**
   * R2에서 파일 삭제. 실패해도 예외를 throw 하지 않고 로그만 남김.
   * (DB는 이미 삭제됐을 수 있어 호출자 흐름을 막지 않기 위함. 고아 파일은 R2 무료 한도 내 무해)
   */
  async deleteFile(fileUrl: string): Promise<void> {
    try {
      if (!fileUrl || !this.publicUrlPrefix) return;
      // publicUrlPrefix를 잘라내고 key만 추출
      const key = fileUrl.startsWith(this.publicUrlPrefix)
        ? fileUrl.slice(this.publicUrlPrefix.length + 1)
        : new URL(fileUrl).pathname.slice(1);

      await this.s3.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      this.logger.warn(
        `R2 파일 삭제 실패 (무시): ${fileUrl}, ${(err as Error).message}`,
      );
    }
  }
}
