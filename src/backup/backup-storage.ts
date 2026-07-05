import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface BackupObject {
  key: string;
  size: number;
}

/**
 * R2 백업 전용 버킷 접근 (BackupService 에서 분리 — spec 에서 typed mock 주입용).
 * 백업 전용 자격증명(BACKUP_R2_*) 우선, 미설정 시 앱 R2_* 재사용.
 */
@Injectable()
export class BackupStorage {
  private readonly s3: S3Client;
  /** readonly 아님 — spec 에서 mock 주입 시 설정 (jest-mock-extended) */
  bucket: string;

  constructor(config: ConfigService) {
    this.bucket = config.get('BACKUP_R2_BUCKET', '');
    this.s3 = new S3Client({
      region: 'auto',
      endpoint:
        config.get('BACKUP_R2_ENDPOINT') || config.get('R2_ENDPOINT', ''),
      credentials: {
        accessKeyId:
          config.get('BACKUP_R2_ACCESS_KEY_ID') ||
          config.get('R2_ACCESS_KEY_ID', ''),
        secretAccessKey:
          config.get('BACKUP_R2_SECRET_ACCESS_KEY') ||
          config.get('R2_SECRET_ACCESS_KEY', ''),
      },
    });
  }

  async putObject(key: string, body: Buffer): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/octet-stream',
      }),
    );
  }

  async listObjects(prefix: string): Promise<BackupObject[]> {
    const res = await this.s3.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }),
    );
    return (res.Contents ?? []).map((o) => ({
      key: o.Key ?? '',
      size: o.Size ?? 0,
    }));
  }

  async deleteObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.s3.send(
      new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: keys.map((k) => ({ Key: k })) },
      }),
    );
  }
}
