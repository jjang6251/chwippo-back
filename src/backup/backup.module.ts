import { Module } from '@nestjs/common';
import { BackupService } from './backup.service';
import { BackupCron } from './backup.cron';
import { PgDumpRunner } from './backup-pg-dump';
import { BackupStorage } from './backup-storage';

/**
 * N1 DB 자동 백업 — pg_dump → 암호화 → R2. BACKUP_ENABLED=true 일 때만 동작.
 * DiscordNotifier 는 NotifierModule 이 @Global 제공.
 */
@Module({
  providers: [BackupService, BackupCron, PgDumpRunner, BackupStorage],
})
export class BackupModule {}
