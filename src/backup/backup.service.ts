import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscordNotifier, DISCORD_COLORS } from '../common/discord-notifier';
import { toKstDateString } from '../common/datetime';
import { encryptBackup, parseBackupKey } from './backup-crypto';
import { PgDumpRunner } from './backup-pg-dump';
import { BackupStorage } from './backup-storage';

/**
 * N1 DB 자동 백업 (2026-07-06 CEO 승인 6개 결정)
 *
 * - 오프플랫폼 이중화: Railway 관리형 백업(7일)과 별개로 R2 백업 전용 버킷에 저장
 * - pg_dump -Fc (자체 압축) → AES-256-GCM 암호화 → R2 업로드
 * - retention: daily/ 7일 · weekly/ 28일 (키의 날짜 파싱 기준 — LastModified 비의존)
 * - 실패 시 Discord critical · 주 1회 heartbeat 는 BackupCron
 * - DB 테이블 없음 — 실행 이력은 R2 객체 목록 자체가 소스
 *
 * 복구 절차: deployment.md §19 "DB 자동 백업 · 복구" 참조.
 */

export interface BackupRunResult {
  ok: boolean;
  uploadedKeys: string[];
  deletedCount: number;
  sizeBytes: number;
  error?: string;
}

export interface HeartbeatSummary {
  expectedDays: number;
  presentDays: number;
  missingDates: string[];
  latestKey?: string;
  latestSizeBytes?: number;
}

const DAILY_PREFIX = 'daily/';
const WEEKLY_PREFIX = 'weekly/';
const DAILY_RETENTION_DAYS = 7;
const WEEKLY_RETENTION_DAYS = 28;
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly notifier: DiscordNotifier,
    private readonly pgDump: PgDumpRunner,
    private readonly storage: BackupStorage,
  ) {}

  isEnabled(): boolean {
    return this.config.get('BACKUP_ENABLED') === 'true';
  }

  /**
   * 백업 1회 실행. cron 안정성을 위해 throw 하지 않고 결과 객체 반환
   * (실패는 Discord critical + logger.error).
   */
  async runBackup(now: Date = new Date()): Promise<BackupRunResult> {
    const result: BackupRunResult = {
      ok: false,
      uploadedKeys: [],
      deletedCount: 0,
      sizeBytes: 0,
    };
    if (!this.isEnabled()) {
      this.logger.log('BACKUP_ENABLED != true — 백업 skip');
      return { ...result, ok: true };
    }

    const key = parseBackupKey(this.config.get('BACKUP_ENCRYPTION_KEY'));
    if (!key) {
      return this.fail(
        result,
        'config',
        'BACKUP_ENCRYPTION_KEY 미설정 또는 형식 오류 (64 hex 필요)',
      );
    }
    if (!this.storage.bucket) {
      return this.fail(result, 'config', 'BACKUP_R2_BUCKET 미설정');
    }

    // 1. pg_dump
    let dump: Buffer;
    try {
      dump = await this.pgDump.run();
    } catch (err) {
      return this.fail(result, 'pg_dump', (err as Error).message);
    }
    if (dump.length === 0) {
      return this.fail(result, 'pg_dump', 'dump 결과가 0 byte');
    }

    // 2. 암호화
    const encrypted = encryptBackup(dump, key);
    result.sizeBytes = encrypted.length;

    // 3. 업로드 — daily + (KST 일요일) weekly
    const dateStr = toKstDateString(now);
    const filename = `chwippo-${dateStr}.dump.enc`;
    const targets = [`${DAILY_PREFIX}${filename}`];
    if (this.isSundayKst(now)) targets.push(`${WEEKLY_PREFIX}${filename}`);

    for (const objectKey of targets) {
      try {
        await this.storage.putObject(objectKey, encrypted);
        result.uploadedKeys.push(objectKey);
      } catch (err) {
        return this.fail(
          result,
          'upload',
          `${objectKey}: ${(err as Error).message}`,
        );
      }
    }

    // 4. retention 정리 (업로드 성공 후에만 — 실패해도 기존 백업 보존)
    try {
      result.deletedCount = await this.cleanupRetention(now);
    } catch (err) {
      // 삭제 실패는 백업 자체의 실패가 아님 — 경고만
      this.logger.warn(`retention 정리 실패: ${(err as Error).message}`);
    }

    result.ok = true;
    this.logger.log(
      `백업 완료 — ${result.uploadedKeys.join(', ')} (${Math.round(result.sizeBytes / 1024)}KB, retention 삭제 ${result.deletedCount}건)`,
    );
    return result;
  }

  /** daily/ 7일 · weekly/ 28일 초과 객체 삭제. 키의 날짜(chwippo-YYYY-MM-DD) 기준. */
  async cleanupRetention(now: Date): Promise<number> {
    const expired: string[] = [
      ...(await this.findExpiredKeys(DAILY_PREFIX, DAILY_RETENTION_DAYS, now)),
      ...(await this.findExpiredKeys(
        WEEKLY_PREFIX,
        WEEKLY_RETENTION_DAYS,
        now,
      )),
    ];
    await this.storage.deleteObjects(expired);
    return expired.length;
  }

  /** 주 1회 heartbeat 용 — 최근 7일 daily/ 존재 현황 집계 */
  async summarizeLastWeek(now: Date = new Date()): Promise<HeartbeatSummary> {
    const objects = await this.storage.listObjects(DAILY_PREFIX);
    const byDate = new Map<string, { key: string; size: number }>();
    for (const obj of objects) {
      const date = this.parseDateFromKey(obj.key);
      if (date) byDate.set(date, obj);
    }

    const missingDates: string[] = [];
    let latest: { key: string; size: number } | undefined;
    // 오늘(04:00 실행분) 포함 최근 7일, 오늘부터 역순
    for (let i = 0; i < DAILY_RETENTION_DAYS; i++) {
      const date = toKstDateString(new Date(now.getTime() - i * DAY_MS));
      const found = byDate.get(date);
      if (!found) missingDates.push(date);
      else if (!latest) latest = found;
    }
    return {
      expectedDays: DAILY_RETENTION_DAYS,
      presentDays: DAILY_RETENTION_DAYS - missingDates.length,
      missingDates,
      latestKey: latest?.key,
      latestSizeBytes: latest?.size,
    };
  }

  /** KST 기준 일요일 여부 (weekly 승격 판정) */
  isSundayKst(date: Date): boolean {
    return (
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Seoul',
        weekday: 'short',
      }).format(date) === 'Sun'
    );
  }

  // ── 내부 ──────────────────────────────────────────────

  private async findExpiredKeys(
    prefix: string,
    retentionDays: number,
    now: Date,
  ): Promise<string[]> {
    const cutoff = toKstDateString(
      new Date(now.getTime() - retentionDays * DAY_MS),
    );
    const objects = await this.storage.listObjects(prefix);
    return objects
      .map((o) => o.key)
      .filter((k) => {
        const date = this.parseDateFromKey(k);
        return date !== null && date < cutoff; // YYYY-MM-DD 사전순 = 시간순
      });
  }

  private parseDateFromKey(key: string): string | null {
    const m = key.match(/chwippo-(\d{4}-\d{2}-\d{2})\.dump\.enc$/);
    return m ? m[1] : null;
  }

  private async fail(
    result: BackupRunResult,
    stage: string,
    message: string,
  ): Promise<BackupRunResult> {
    this.logger.error(`백업 실패 [${stage}] ${message}`);
    await this.notifier.notify(
      {
        title: '🛑 DB 백업 실패',
        description: `단계: **${stage}**\n${message.slice(0, 800)}`,
        color: DISCORD_COLORS.red,
      },
      'critical',
    );
    return { ...result, ok: false, error: `[${stage}] ${message}` };
  }
}
