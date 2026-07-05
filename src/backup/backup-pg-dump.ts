import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';

/** pg_dump 행 방지 — 10분 초과 시 kill */
const PG_DUMP_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * pg_dump 실행기 (BackupService 에서 분리 — spec 에서 typed mock 주입용).
 * -Fc = custom format: 자체 압축 + pg_restore 선택 복원 지원.
 */
@Injectable()
export class PgDumpRunner {
  constructor(private readonly config: ConfigService) {}

  run(): Promise<Buffer> {
    const host = this.config.get<string>('DB_HOST', 'localhost');
    const port = String(this.config.get<string>('DB_PORT', '5432'));
    const user = this.config.get<string>('DB_USERNAME', '');
    const database = this.config.get<string>('DB_DATABASE', 'chwippo');
    const ssl = this.config.get<string>('DB_SSL') === 'true';

    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        'pg_dump',
        [
          '-h',
          host,
          '-p',
          port,
          '-U',
          user,
          '-Fc',
          '--no-owner',
          '--no-acl',
          database,
        ],
        {
          env: {
            ...process.env,
            PGPASSWORD: this.config.get('DB_PASSWORD', ''),
            ...(ssl ? { PGSSLMODE: 'require' } : {}),
          },
        },
      );
      const chunks: Buffer[] = [];
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`pg_dump timeout (${PG_DUMP_TIMEOUT_MS / 1000}s)`));
      }, PG_DUMP_TIMEOUT_MS);

      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      child.on('error', (err) => {
        clearTimeout(timer);
        // ENOENT = 이미지에 pg_dump 없음 (nixpacks.toml / Dockerfile 확인)
        reject(new Error(`pg_dump spawn 실패: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`pg_dump exit ${code}: ${stderr.slice(0, 500)}`));
      });
    });
  }
}
