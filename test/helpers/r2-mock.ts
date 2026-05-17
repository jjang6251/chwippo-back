/**
 * E2E R2/S3 mock 헬퍼 (LRR P2T1 PR P0 인프라).
 *
 * AWS SDK S3 호출을 jest.mock으로 차단 — 실 R2 호출 없이 controller→service 흐름 검증.
 * jest setup에서 사용하거나, 개별 e2e spec에서 require 직전 호출.
 *
 * 사용 (jest setup):
 *   import { setupR2Mock } from './helpers/r2-mock';
 *   setupR2Mock();
 *
 * 사용 (개별 spec, presigned URL 검증용):
 *   jest.mock('@aws-sdk/s3-request-presigner', () => ({
 *     getSignedUrl: jest.fn().mockResolvedValue('https://mock-upload-url'),
 *   }));
 *   jest.mock('@aws-sdk/client-s3', () => mockS3());
 */
import type { Mock } from 'jest-mock';

export interface MockedS3 {
  send: Mock;
  S3Client: Mock;
  PutObjectCommand: Mock;
  DeleteObjectCommand: Mock;
}

/** S3Client·Command 클래스를 mock 객체로 치환. */
export function mockS3(): {
  send: jest.Mock;
  S3Client: jest.Mock;
  PutObjectCommand: jest.Mock;
  DeleteObjectCommand: jest.Mock;
} {
  const send = jest.fn().mockResolvedValue({});
  return {
    send,
    S3Client: jest.fn().mockImplementation(() => ({ send })),
    PutObjectCommand: jest.fn().mockImplementation((args: unknown) => ({
      ...(args as object),
      _type: 'PutObjectCommand',
    })),
    DeleteObjectCommand: jest.fn().mockImplementation((args: unknown) => ({
      ...(args as object),
      _type: 'DeleteObjectCommand',
    })),
  };
}

/** getSignedUrl mock — presigned URL 반환. */
export function mockGetSignedUrl(
  url = 'https://mock-presigned-url.example.com/path?sig=test',
): jest.Mock {
  return jest.fn().mockResolvedValue(url);
}
