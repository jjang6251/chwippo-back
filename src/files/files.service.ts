import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};
const MAX_BYTES = 10 * 1024 * 1024; // 10MB

@Injectable()
export class FilesService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    this.s3 = new S3Client({
      region: config.get('AWS_REGION', 'ap-northeast-2'),
      credentials: {
        accessKeyId: config.get('AWS_ACCESS_KEY_ID', ''),
        secretAccessKey: config.get('AWS_SECRET_ACCESS_KEY', ''),
      },
    });
    this.bucket = config.get('AWS_S3_BUCKET', 'chwippo');
  }

  async createPresignedUrl(
    userId: string,
    scope: string,  // e.g. 'myinfo/language-cert', 'myinfo/cert'
    contentType: string,
    fileSize: number,
  ): Promise<{ uploadUrl: string; fileUrl: string }> {
    if (!ALLOWED_TYPES[contentType]) {
      throw new BadRequestException('허용되지 않는 파일 형식입니다. PDF, JPG, PNG만 가능합니다.');
    }
    if (fileSize > MAX_BYTES) {
      throw new BadRequestException('파일 크기는 10MB 이하여야 합니다.');
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
    const fileUrl = `https://${this.bucket}.s3.${this.config.get('AWS_REGION', 'ap-northeast-2')}.amazonaws.com/${key}`;

    return { uploadUrl, fileUrl };
  }

  async deleteFile(fileUrl: string): Promise<void> {
    const url = new URL(fileUrl);
    const key = url.pathname.slice(1); // remove leading slash
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
