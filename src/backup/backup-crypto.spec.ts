import {
  BACKUP_MAGIC,
  decryptBackup,
  encryptBackup,
  parseBackupKey,
} from './backup-crypto';

/**
 * N1 백업 암호화 spec.
 *
 * 시나리오 매트릭스:
 * - parseBackupKey: 정상 64 hex / undefined / 길이 부족 / 비 hex 문자
 * - encrypt→decrypt roundtrip 원문 일치
 * - 암호문에 평문 미노출
 * - 다른 키로 복호화 → throw (GCM auth 실패)
 * - magic 훼손 → throw (형식 검증)
 */
describe('backup-crypto', () => {
  const KEY_HEX = 'a'.repeat(64);
  const key = parseBackupKey(KEY_HEX);

  describe('parseBackupKey', () => {
    it('정상 64 hex → 32 byte Buffer', () => {
      expect(key).not.toBeNull();
      expect(key?.length).toBe(32);
    });

    it('undefined → null', () => {
      expect(parseBackupKey(undefined)).toBeNull();
    });

    it('길이 부족 → null', () => {
      expect(parseBackupKey('abcd')).toBeNull();
    });

    it('비 hex 문자 포함 → null', () => {
      expect(parseBackupKey('z'.repeat(64))).toBeNull();
    });
  });

  describe('encryptBackup / decryptBackup', () => {
    const plain = Buffer.from('PGDMP-테스트-덤프-내용-1234567890');

    it('roundtrip 원문 일치', () => {
      const encrypted = encryptBackup(plain, key!);
      expect(decryptBackup(encrypted, key!).equals(plain)).toBe(true);
    });

    it('암호문에 평문이 노출되지 않음', () => {
      const encrypted = encryptBackup(plain, key!);
      expect(encrypted.includes(plain)).toBe(false);
      expect(
        encrypted.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC),
      ).toBe(true);
    });

    it('다른 키로 복호화 → throw (GCM auth 실패)', () => {
      const encrypted = encryptBackup(plain, key!);
      const otherKey = parseBackupKey('b'.repeat(64))!;
      expect(() => decryptBackup(encrypted, otherKey)).toThrow();
    });

    it('magic 훼손 → 형식 오류 throw', () => {
      const encrypted = encryptBackup(plain, key!);
      encrypted[0] = 0x00;
      expect(() => decryptBackup(encrypted, key!)).toThrow('magic');
    });
  });
});
