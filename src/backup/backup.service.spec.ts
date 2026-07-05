import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { mock } from 'jest-mock-extended';
import { DiscordNotifier } from '../common/discord-notifier';
import { decryptBackup, parseBackupKey } from './backup-crypto';
import { PgDumpRunner } from './backup-pg-dump';
import { BackupStorage } from './backup-storage';
import { BackupService } from './backup.service';

/**
 * N1 BackupService spec.
 *
 * 시나리오 매트릭스:
 * - runBackup: BACKUP_ENABLED off → skip (ok, 업로드 X)
 *              암호화 키 미설정/형식 오류 → fail(config) + Discord critical
 *              버킷 미설정 → fail(config)
 *              정상 (평일) → daily/ 1건 업로드 + 암호문 복호화 시 dump 원문
 *              정상 (KST 일요일) → daily/ + weekly/ 2건
 *              pg_dump 실패 → fail(pg_dump) + 업로드 X
 *              dump 0 byte → fail(pg_dump)
 *              업로드 실패 → fail(upload)
 *              retention 실패 → 백업 자체는 ok (경고만)
 * - cleanupRetention: cutoff 이전 삭제 / cutoff 당일 유지 / 패턴 불일치 키 무시 / weekly 28일
 * - summarizeLastWeek: 7/7 결손 없음 / 결손일 목록 + 최신 크기
 * - isSundayKst: KST 일요일 true / 월요일 false / KST 일요일 밤(UTC 토요일) true
 */
describe('BackupService', () => {
  let service: BackupService;
  let config: jest.Mocked<ConfigService>;
  let notifier: jest.Mocked<DiscordNotifier>;
  let pgDump: jest.Mocked<PgDumpRunner>;
  let storage: jest.Mocked<BackupStorage>;

  const KEY_HEX = 'c'.repeat(64);
  const DUMP = Buffer.from('PGDMP-fake-dump-content');
  /** 2026-07-06 04:00 KST = 월요일 */
  const MONDAY = new Date('2026-07-06T04:00:00+09:00');
  /** 2026-07-05 04:00 KST = 일요일 */
  const SUNDAY = new Date('2026-07-05T04:00:00+09:00');

  let cfg: Record<string, string>;

  beforeEach(async () => {
    cfg = {
      BACKUP_ENABLED: 'true',
      BACKUP_ENCRYPTION_KEY: KEY_HEX,
    };
    config = mock<ConfigService>();
    config.get.mockImplementation(
      (key: string, def?: unknown) => cfg[key] ?? def,
    );
    notifier = mock<DiscordNotifier>();
    notifier.notify.mockResolvedValue('sent');
    pgDump = mock<PgDumpRunner>();
    pgDump.run.mockResolvedValue(DUMP);
    storage = mock<BackupStorage>();
    storage.bucket = 'chwippo-backup';
    storage.putObject.mockResolvedValue(undefined);
    storage.listObjects.mockResolvedValue([]);
    storage.deleteObjects.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupService,
        { provide: ConfigService, useValue: config },
        { provide: DiscordNotifier, useValue: notifier },
        { provide: PgDumpRunner, useValue: pgDump },
        { provide: BackupStorage, useValue: storage },
      ],
    }).compile();
    service = module.get(BackupService);
  });

  describe('runBackup', () => {
    it('BACKUP_ENABLED off → skip (ok, 업로드 X)', async () => {
      cfg.BACKUP_ENABLED = 'false';
      const res = await service.runBackup(MONDAY);
      expect(res.ok).toBe(true);
      expect(storage.putObject).not.toHaveBeenCalled();
      expect(pgDump.run).not.toHaveBeenCalled();
    });

    it('암호화 키 형식 오류 → fail(config) + Discord critical', async () => {
      cfg.BACKUP_ENCRYPTION_KEY = 'too-short';
      const res = await service.runBackup(MONDAY);
      expect(res.ok).toBe(false);
      expect(res.error).toContain('[config]');
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('백업 실패'),
        }),
        'critical',
      );
    });

    it('버킷 미설정 → fail(config)', async () => {
      storage.bucket = '';
      const res = await service.runBackup(MONDAY);
      expect(res.ok).toBe(false);
      expect(res.error).toContain('BACKUP_R2_BUCKET');
    });

    it('정상 (월요일) → daily/ 1건 + 암호문 복호화 시 dump 원문', async () => {
      const res = await service.runBackup(MONDAY);
      expect(res.ok).toBe(true);
      expect(res.uploadedKeys).toEqual(['daily/chwippo-2026-07-06.dump.enc']);
      expect(storage.putObject).toHaveBeenCalledTimes(1);

      const [, body] = storage.putObject.mock.calls[0];
      const key = parseBackupKey(KEY_HEX)!;
      expect(decryptBackup(body, key).equals(DUMP)).toBe(true);
    });

    it('정상 (KST 일요일) → daily/ + weekly/ 2건', async () => {
      const res = await service.runBackup(SUNDAY);
      expect(res.ok).toBe(true);
      expect(res.uploadedKeys).toEqual([
        'daily/chwippo-2026-07-05.dump.enc',
        'weekly/chwippo-2026-07-05.dump.enc',
      ]);
    });

    it('pg_dump 실패 → fail(pg_dump) + 업로드 X', async () => {
      pgDump.run.mockRejectedValue(
        new Error('pg_dump exit 1: connection refused'),
      );
      const res = await service.runBackup(MONDAY);
      expect(res.ok).toBe(false);
      expect(res.error).toContain('[pg_dump]');
      expect(storage.putObject).not.toHaveBeenCalled();
    });

    it('dump 0 byte → fail(pg_dump)', async () => {
      pgDump.run.mockResolvedValue(Buffer.alloc(0));
      const res = await service.runBackup(MONDAY);
      expect(res.ok).toBe(false);
      expect(res.error).toContain('0 byte');
    });

    it('업로드 실패 → fail(upload)', async () => {
      storage.putObject.mockRejectedValue(new Error('R2 503'));
      const res = await service.runBackup(MONDAY);
      expect(res.ok).toBe(false);
      expect(res.error).toContain('[upload]');
    });

    it('retention 실패 → 백업 자체는 ok (경고만, critical 알림 X)', async () => {
      storage.listObjects.mockRejectedValue(new Error('list 실패'));
      const res = await service.runBackup(MONDAY);
      expect(res.ok).toBe(true);
      expect(notifier.notify).not.toHaveBeenCalled();
    });
  });

  describe('cleanupRetention', () => {
    it('daily cutoff(7일) 이전 삭제 · 당일 유지 · 패턴 불일치 무시 / weekly 28일', async () => {
      // MONDAY(07-06) 기준 daily cutoff = 06-29, weekly cutoff = 06-08
      storage.listObjects.mockImplementation(async (prefix: string) =>
        prefix === 'daily/'
          ? [
              { key: 'daily/chwippo-2026-06-28.dump.enc', size: 10 }, // < cutoff → 삭제
              { key: 'daily/chwippo-2026-06-29.dump.enc', size: 10 }, // == cutoff → 유지
              { key: 'daily/chwippo-2026-07-05.dump.enc', size: 10 }, // 유지
              { key: 'daily/readme.txt', size: 1 }, // 패턴 불일치 → 무시
            ]
          : [
              { key: 'weekly/chwippo-2026-06-07.dump.enc', size: 10 }, // < cutoff → 삭제
              { key: 'weekly/chwippo-2026-06-14.dump.enc', size: 10 }, // 유지
            ],
      );
      const deleted = await service.cleanupRetention(MONDAY);
      expect(deleted).toBe(2);
      expect(storage.deleteObjects).toHaveBeenCalledWith([
        'daily/chwippo-2026-06-28.dump.enc',
        'weekly/chwippo-2026-06-07.dump.enc',
      ]);
    });
  });

  describe('summarizeLastWeek', () => {
    it('7일 전부 존재 → 결손 없음 + 최신 키·크기', async () => {
      const days = [
        '2026-06-30',
        '2026-07-01',
        '2026-07-02',
        '2026-07-03',
        '2026-07-04',
        '2026-07-05',
        '2026-07-06',
      ];
      storage.listObjects.mockResolvedValue(
        days.map((d) => ({ key: `daily/chwippo-${d}.dump.enc`, size: 2048 })),
      );
      const s = await service.summarizeLastWeek(MONDAY);
      expect(s.presentDays).toBe(7);
      expect(s.missingDates).toEqual([]);
      expect(s.latestKey).toBe('daily/chwippo-2026-07-06.dump.enc');
      expect(s.latestSizeBytes).toBe(2048);
    });

    it('결손 있음 → missingDates 에 해당 날짜', async () => {
      storage.listObjects.mockResolvedValue([
        { key: 'daily/chwippo-2026-07-06.dump.enc', size: 1024 },
        { key: 'daily/chwippo-2026-07-04.dump.enc', size: 1024 },
      ]);
      const s = await service.summarizeLastWeek(MONDAY);
      expect(s.presentDays).toBe(2);
      expect(s.missingDates).toContain('2026-07-05');
      expect(s.latestKey).toBe('daily/chwippo-2026-07-06.dump.enc');
    });
  });

  describe('isSundayKst', () => {
    it('KST 일요일 새벽 → true', () => {
      expect(service.isSundayKst(SUNDAY)).toBe(true);
    });

    it('KST 월요일 → false', () => {
      expect(service.isSundayKst(MONDAY)).toBe(false);
    });

    it('KST 일요일 밤 (UTC 토요일) → true — 타임존 경계', () => {
      expect(service.isSundayKst(new Date('2026-07-05T23:59:00+09:00'))).toBe(
        true,
      );
    });
  });
});
