/**
 * N1 DB 백업 복호화 CLI.
 *
 * 사용:
 *   BACKUP_ENCRYPTION_KEY=<64 hex> npx ts-node scripts/decrypt-backup.ts <input.dump.enc> [output.dump]
 *
 * 출력(.dump)은 pg_dump custom format — 복원:
 *   pg_restore --no-owner --no-acl -d <DB접속문자열> output.dump
 *
 * 전체 복구 절차 = company/07_ops/deployment.md §19
 */
import { readFileSync, writeFileSync } from 'fs';
import { decryptBackup, parseBackupKey } from '../src/backup/backup-crypto';

function main(): void {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error(
      '사용법: BACKUP_ENCRYPTION_KEY=<64 hex> npx ts-node scripts/decrypt-backup.ts <input.dump.enc> [output.dump]',
    );
    process.exit(1);
  }
  const key = parseBackupKey(process.env.BACKUP_ENCRYPTION_KEY);
  if (!key) {
    console.error('BACKUP_ENCRYPTION_KEY 환경변수 필요 (64 hex chars)');
    process.exit(1);
  }
  const outPath = output ?? input.replace(/\.enc$/, '');
  const plain = decryptBackup(readFileSync(input), key);
  writeFileSync(outPath, plain);
  console.log(`복호화 완료: ${outPath} (${Math.round(plain.length / 1024)}KB)`);
}

main();
