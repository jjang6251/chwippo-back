import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * N1 DB 백업 — 대칭 암호화 (AES-256-GCM).
 *
 * plan 원안은 gpg 였으나 Railway nixpacks 이미지에 gpg 바이너리가 없어
 * Node 내장 crypto 로 대체 (동일한 env 키 기반 대칭 암호화 의도 유지).
 *
 * 파일 포맷: [6B magic "CHWBK1"][12B iv][ciphertext...][16B authTag]
 * 복호화: `npx ts-node scripts/decrypt-backup.ts <file>` (BACKUP_ENCRYPTION_KEY 필요)
 */

export const BACKUP_MAGIC = Buffer.from('CHWBK1');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** 64 hex chars → 32 byte key. 형식 불일치 시 null (caller 가 알림 처리). */
export function parseBackupKey(hex: string | undefined): Buffer | null {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

export function encryptBackup(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([BACKUP_MAGIC, iv, ciphertext, cipher.getAuthTag()]);
}

export function decryptBackup(encrypted: Buffer, key: Buffer): Buffer {
  const magic = encrypted.subarray(0, BACKUP_MAGIC.length);
  if (!magic.equals(BACKUP_MAGIC)) {
    throw new Error('백업 파일 형식이 아님 (magic 불일치)');
  }
  const iv = encrypted.subarray(
    BACKUP_MAGIC.length,
    BACKUP_MAGIC.length + IV_LENGTH,
  );
  const tag = encrypted.subarray(encrypted.length - TAG_LENGTH);
  const ciphertext = encrypted.subarray(
    BACKUP_MAGIC.length + IV_LENGTH,
    encrypted.length - TAG_LENGTH,
  );
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
