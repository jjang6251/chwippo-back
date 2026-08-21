import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { EntityManager, Repository } from 'typeorm';
import { StorageUsageService } from './storage-usage.service';
import { Cert } from './entities/cert.entity';
import { Award } from './entities/award.entity';
import { LanguageCert } from './entities/language-cert.entity';
import { Document } from './entities/document.entity';
import { Education } from './entities/education.entity';

interface FakeQB {
  select: jest.Mock;
  where: jest.Mock;
  getRawOne: jest.Mock;
  getRawMany: jest.Mock;
}

const makeQb = (
  rawOne: { total: string } | null,
  rawMany: Array<{ file_url: string }> = [],
): FakeQB => {
  const qb: FakeQB = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(rawOne),
    getRawMany: jest.fn().mockResolvedValue(rawMany),
  };
  return qb;
};

describe('StorageUsageService', () => {
  let service: StorageUsageService;
  let certRepo: jest.Mocked<Repository<Cert>>;
  let awardRepo: jest.Mocked<Repository<Award>>;
  let langCertRepo: jest.Mocked<Repository<LanguageCert>>;
  let docRepo: jest.Mocked<Repository<Document>>;
  let eduRepo: jest.Mocked<Repository<Education>>;
  let configGet: jest.Mock;
  /** note_attachments 는 크기 컬럼이 둘이라 repo 루프가 아니라 raw 쿼리로 읽는다 */
  let dataSourceQuery: jest.Mock;

  beforeEach(async () => {
    certRepo = mock<Repository<Cert>>();
    awardRepo = mock<Repository<Award>>();
    langCertRepo = mock<Repository<LanguageCert>>();
    docRepo = mock<Repository<Document>>();
    eduRepo = mock<Repository<Education>>();
    configGet = jest.fn().mockReturnValue(100); // 기본 100MB
    dataSourceQuery = jest.fn().mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageUsageService,
        { provide: getRepositoryToken(Cert), useValue: certRepo },
        { provide: getRepositoryToken(Award), useValue: awardRepo },
        { provide: getRepositoryToken(LanguageCert), useValue: langCertRepo },
        { provide: getRepositoryToken(Document), useValue: docRepo },
        { provide: getRepositoryToken(Education), useValue: eduRepo },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: getDataSourceToken(), useValue: { query: dataSourceQuery } },
      ],
    }).compile();

    service = module.get<StorageUsageService>(StorageUsageService);
  });

  describe('getLimitBytes', () => {
    it('MAX_STORAGE_PER_USER_MB=100 → 100 * 1024 * 1024 반환', () => {
      configGet.mockReturnValue(100);
      expect(service.getLimitBytes()).toBe(100 * 1024 * 1024);
    });

    it('MAX_STORAGE_PER_USER_MB=200 → 200MB 반환 (환경변수로 cap 조정 가능, H-8)', () => {
      configGet.mockReturnValue(200);
      expect(service.getLimitBytes()).toBe(200 * 1024 * 1024);
    });
  });

  describe('calculateUsage', () => {
    it('5개 테이블 SUM 합산 — file_size_bytes 누적', async () => {
      certRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '1000000' }) as unknown as ReturnType<
          Repository<Cert>['createQueryBuilder']
        >,
      );
      awardRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '2000000' }) as unknown as ReturnType<
          Repository<Award>['createQueryBuilder']
        >,
      );
      langCertRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '500000' }) as unknown as ReturnType<
          Repository<LanguageCert>['createQueryBuilder']
        >,
      );
      docRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '300000' }) as unknown as ReturnType<
          Repository<Document>['createQueryBuilder']
        >,
      );
      eduRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '100000' }) as unknown as ReturnType<
          Repository<Education>['createQueryBuilder']
        >,
      );

      const total = await service.calculateUsage('user-1');
      expect(total).toBe(1000000 + 2000000 + 500000 + 300000 + 100000);
    });

    it('NULL SUM 결과 (모든 row file_size_bytes NULL) → 0 (E-2)', async () => {
      const qb = makeQb({ total: '0' });
      certRepo.createQueryBuilder.mockReturnValue(qb as never);
      awardRepo.createQueryBuilder.mockReturnValue(qb as never);
      langCertRepo.createQueryBuilder.mockReturnValue(qb as never);
      docRepo.createQueryBuilder.mockReturnValue(qb as never);
      eduRepo.createQueryBuilder.mockReturnValue(qb as never);

      const total = await service.calculateUsage('user-1');
      expect(total).toBe(0);
    });
  });

  describe('getUsage', () => {
    it('사용량·한도·퍼센티지 반환 (H-2)', async () => {
      const qb = makeQb({ total: String(50 * 1024 * 1024) }); // 50MB
      certRepo.createQueryBuilder.mockReturnValue(qb as never);
      awardRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '0' }) as never,
      );
      langCertRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '0' }) as never,
      );
      docRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '0' }) as never,
      );
      eduRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '0' }) as never,
      );

      const usage = await service.getUsage('user-1');
      expect(usage.usedBytes).toBe(50 * 1024 * 1024);
      expect(usage.limitBytes).toBe(100 * 1024 * 1024);
      expect(usage.usedMB).toBe(50);
      expect(usage.limitMB).toBe(100);
      expect(usage.percentage).toBe(50);
    });

    it('신규 유저 (파일 없음) → 0/0%/100MB (E-1)', async () => {
      const qb = makeQb({ total: '0' });
      certRepo.createQueryBuilder.mockReturnValue(qb as never);
      awardRepo.createQueryBuilder.mockReturnValue(qb as never);
      langCertRepo.createQueryBuilder.mockReturnValue(qb as never);
      docRepo.createQueryBuilder.mockReturnValue(qb as never);
      eduRepo.createQueryBuilder.mockReturnValue(qb as never);

      const usage = await service.getUsage('user-new');
      expect(usage.usedBytes).toBe(0);
      expect(usage.percentage).toBe(0);
    });
  });

  describe('assertWithinLimit', () => {
    it('사용량 50MB + 추가 5MB ≤ 100MB → 통과', async () => {
      const qb = makeQb({ total: String(50 * 1024 * 1024) });
      certRepo.createQueryBuilder.mockReturnValue(qb as never);
      [awardRepo, langCertRepo, docRepo, eduRepo].forEach((r) =>
        r.createQueryBuilder.mockReturnValue(makeQb({ total: '0' }) as never),
      );

      await expect(
        service.assertWithinLimit(
          'user-1',
          5 * 1024 * 1024,
          undefined as never,
        ),
      ).resolves.toBeUndefined();
    });

    it('사용량 99MB + 추가 5MB > 100MB → BadRequestException (FB-6)', async () => {
      const qb = makeQb({ total: String(99 * 1024 * 1024) });
      certRepo.createQueryBuilder.mockReturnValue(qb as never);
      [awardRepo, langCertRepo, docRepo, eduRepo].forEach((r) =>
        r.createQueryBuilder.mockReturnValue(makeQb({ total: '0' }) as never),
      );

      await expect(
        service.assertWithinLimit(
          'user-1',
          5 * 1024 * 1024,
          undefined as never,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('경계값: 사용량 95MB + 추가 5MB = 100MB → 통과 (정확히 cap)', async () => {
      const qb = makeQb({ total: String(95 * 1024 * 1024) });
      certRepo.createQueryBuilder.mockReturnValue(qb as never);
      [awardRepo, langCertRepo, docRepo, eduRepo].forEach((r) =>
        r.createQueryBuilder.mockReturnValue(makeQb({ total: '0' }) as never),
      );

      await expect(
        service.assertWithinLimit(
          'user-1',
          5 * 1024 * 1024,
          undefined as never,
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('collectAllFileUrls', () => {
    it('5개 테이블에서 file_url 수집 (탈퇴 cascade용, E-6)', async () => {
      certRepo.createQueryBuilder.mockReturnValue(
        makeQb(null, [{ file_url: 'r2://cert-1.pdf' }]) as never,
      );
      awardRepo.createQueryBuilder.mockReturnValue(
        makeQb(null, [
          { file_url: 'r2://award-1.jpg' },
          { file_url: 'r2://award-2.jpg' },
        ]) as never,
      );
      langCertRepo.createQueryBuilder.mockReturnValue(
        makeQb(null, []) as never,
      );
      docRepo.createQueryBuilder.mockReturnValue(
        makeQb(null, [{ file_url: 'r2://doc-1.pdf' }]) as never,
      );
      eduRepo.createQueryBuilder.mockReturnValue(makeQb(null, []) as never);

      const urls = await service.collectAllFileUrls('user-1');
      expect(urls).toEqual([
        'r2://cert-1.pdf',
        'r2://award-1.jpg',
        'r2://award-2.jpg',
        'r2://doc-1.pdf',
      ]);
    });

    it('파일 없는 사용자 → 빈 배열', async () => {
      [certRepo, awardRepo, langCertRepo, docRepo, eduRepo].forEach((r) =>
        r.createQueryBuilder.mockReturnValue(makeQb(null, []) as never),
      );
      const urls = await service.collectAllFileUrls('user-new');
      expect(urls).toEqual([]);
    });
  });

  // ── 전역 통계 (admin 대시보드용) ─────────────────────────
  describe('getGlobalUsage (admin)', () => {
    it('5개 테이블 전체 SUM 반환 (G-1, G-3, G-4)', async () => {
      certRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '10000000' }) as never,
      );
      awardRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '5000000' }) as never,
      );
      langCertRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '2000000' }) as never,
      );
      docRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '3000000' }) as never,
      );
      eduRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '1000000' }) as never,
      );

      const total = await service.getGlobalUsage();
      expect(total).toBe(10000000 + 5000000 + 2000000 + 3000000 + 1000000);
    });

    it('사용자 0명 / 파일 0개 → 0 (G-2, G-6)', async () => {
      [certRepo, awardRepo, langCertRepo, docRepo, eduRepo].forEach((r) =>
        r.createQueryBuilder.mockReturnValue(makeQb({ total: '0' }) as never),
      );
      const total = await service.getGlobalUsage();
      expect(total).toBe(0);
    });

    it('user_id WHERE 조건 없이 전체 합산 (글로벌)', async () => {
      const qbs = [certRepo, awardRepo, langCertRepo, docRepo, eduRepo].map(
        () => {
          const qb = makeQb({ total: '0' });
          return qb;
        },
      );
      [certRepo, awardRepo, langCertRepo, docRepo, eduRepo].forEach((r, i) =>
        r.createQueryBuilder.mockReturnValue(qbs[i] as never),
      );

      await service.getGlobalUsage();

      // global이므로 .where 호출 안 됨
      qbs.forEach((qb) => expect(qb.where).not.toHaveBeenCalled());
    });
  });

  describe('getNearCapUserCount (admin)', () => {
    it('cap 95% 이상 사용자 수 카운트 (G-5)', async () => {
      configGet.mockReturnValue(100); // 100MB cap → 95MB threshold
      // raw query를 위한 dataSource mock 필요 — 다음 helper 사용

      // 이 메서드는 raw 쿼리 사용 — service 구현에서 dataSource.query 호출
      // 테스트는 실제 service.getNearCapUserCount의 raw 쿼리 호출 결과를 mock
      const mockQuery = jest.fn().mockResolvedValue([{ count: '3' }]);
      (service as unknown as { dataSource: { query: jest.Mock } }).dataSource =
        {
          query: mockQuery,
        };

      const count = await service.getNearCapUserCount();
      expect(count).toBe(3);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SUM'),
        expect.arrayContaining([Math.floor(100 * 1024 * 1024 * 0.95)]),
      );
    });

    it('cap 임박 사용자 0명 → 0 (G-2)', async () => {
      const mockQuery = jest.fn().mockResolvedValue([{ count: '0' }]);
      (service as unknown as { dataSource: { query: jest.Mock } }).dataSource =
        {
          query: mockQuery,
        };

      const count = await service.getNearCapUserCount();
      expect(count).toBe(0);
    });
  });

  /**
   * ── 공부 노트 첨부 합산 (미디어 아크 PR-A) ──────────────────────────────
   *
   * 아래 시나리오를 **먼저 나열하고** 코드를 확인했다. 새 파일 테이블이 생겼을 때
   * 조용히 새는 두 구멍(cap 미집계 · 탈퇴 시 R2 잔존)을 정면으로 노린다.
   *
   *  S1 🔴 calculateUsage — myinfo 5테이블 **+ note_attachments** 합산
   *  S2 🔴 note_attachments 는 file_size_bytes + **strokes_size_bytes** 둘 다 더한다
   *  S3 🔴 트랜잭션이면 **manager** 로 읽는다 (락이 본 값과 어긋나면 cap 이 뚫린다)
   *  S4 🔴 assertWithinLimit — 노트 첨부만으로도 한도를 넘으면 400
   *  S5 🔴 collectAllFileUrls — file_url **과** strokes_url (탈퇴 R2 정리)
   *  S6 strokes_url NULL 인 행은 URL 하나만
   *  S7 getGlobalUsage(admin) — note_attachments 포함
   *  S8 🔴 getNearCapUserCount SQL 에 note_attachments 두 컬럼이 UNION 돼 있다
   */
  describe('note_attachments 합산 (공부 노트 첨부)', () => {
    const zeroMyinfo = () =>
      [certRepo, awardRepo, langCertRepo, docRepo, eduRepo].forEach((r) =>
        r.createQueryBuilder.mockReturnValue(makeQb({ total: '0' }) as never),
      );

    it('S1) calculateUsage — myinfo 합계에 note_attachments 를 더한다', async () => {
      certRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '1000' }) as never,
      );
      [awardRepo, langCertRepo, docRepo, eduRepo].forEach((r) =>
        r.createQueryBuilder.mockReturnValue(makeQb({ total: '0' }) as never),
      );
      dataSourceQuery.mockResolvedValue([{ total: '500' }]);

      await expect(service.calculateUsage('user-1')).resolves.toBe(1500);
    });

    it('S2) note_attachments SQL 이 file_size_bytes + strokes_size_bytes 를 더한다', async () => {
      zeroMyinfo();
      dataSourceQuery.mockResolvedValue([{ total: '0' }]);

      await service.calculateUsage('user-1');

      const [sql, params] = dataSourceQuery.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(sql).toContain('note_attachments');
      expect(sql).toContain('file_size_bytes');
      expect(sql).toContain('strokes_size_bytes');
      expect(sql).toMatch(/WHERE user_id = \$1/);
      expect(params).toEqual(['user-1']);
    });

    it('S3) 🔴 manager 전달 시 manager.query 로 읽는다 (락 안 일관성)', async () => {
      zeroMyinfo();
      const managerQuery = jest.fn().mockResolvedValue([{ total: '2048' }]);
      const manager = {
        getRepository: jest.fn().mockReturnValue({
          createQueryBuilder: () => makeQb({ total: '0' }),
        }),
        query: managerQuery,
      } as unknown as EntityManager;

      await expect(service.calculateUsage('user-1', manager)).resolves.toBe(
        2048,
      );
      expect(managerQuery).toHaveBeenCalledTimes(1);
      expect(dataSourceQuery).not.toHaveBeenCalled();
    });

    it('S4) 🔴 assertWithinLimit — 노트 첨부만으로 한도 초과 → 400', async () => {
      zeroMyinfo();
      const managerQuery = jest
        .fn()
        .mockResolvedValue([{ total: String(99 * 1024 * 1024) }]);
      const manager = {
        getRepository: jest.fn().mockReturnValue({
          createQueryBuilder: () => makeQb({ total: '0' }),
        }),
        query: managerQuery,
      } as unknown as EntityManager;

      await expect(
        service.assertWithinLimit('user-1', 5 * 1024 * 1024, manager),
      ).rejects.toThrow(BadRequestException);
    });

    it('S4) 경계 — 노트 첨부 95MB + 5MB = 정확히 cap → 통과', async () => {
      zeroMyinfo();
      const manager = {
        getRepository: jest.fn().mockReturnValue({
          createQueryBuilder: () => makeQb({ total: '0' }),
        }),
        query: jest
          .fn()
          .mockResolvedValue([{ total: String(95 * 1024 * 1024) }]),
      } as unknown as EntityManager;

      await expect(
        service.assertWithinLimit('user-1', 5 * 1024 * 1024, manager),
      ).resolves.toBeUndefined();
    });

    it('S5·S6) 🔴 collectAllFileUrls — file_url 과 strokes_url 을 모두 수집', async () => {
      [certRepo, awardRepo, langCertRepo, docRepo, eduRepo].forEach((r) =>
        r.createQueryBuilder.mockReturnValue(makeQb(null, []) as never),
      );
      dataSourceQuery.mockResolvedValue([
        { file_url: 'r2://note-img.jpg', strokes_url: null },
        { file_url: 'r2://draw.png', strokes_url: 'r2://draw.json' },
      ]);

      await expect(service.collectAllFileUrls('user-1')).resolves.toEqual([
        'r2://note-img.jpg',
        'r2://draw.png',
        'r2://draw.json',
      ]);
    });

    it('S5) collectAllFileUrls — myinfo URL 뒤에 노트 첨부가 붙는다 (둘 다 지운다)', async () => {
      certRepo.createQueryBuilder.mockReturnValue(
        makeQb(null, [{ file_url: 'r2://cert.pdf' }]) as never,
      );
      [awardRepo, langCertRepo, docRepo, eduRepo].forEach((r) =>
        r.createQueryBuilder.mockReturnValue(makeQb(null, []) as never),
      );
      dataSourceQuery.mockResolvedValue([
        { file_url: 'r2://note-img.jpg', strokes_url: null },
      ]);

      await expect(service.collectAllFileUrls('user-1')).resolves.toEqual([
        'r2://cert.pdf',
        'r2://note-img.jpg',
      ]);
    });

    it('S7) getGlobalUsage — note_attachments 포함 · user_id 필터 없음', async () => {
      zeroMyinfo();
      dataSourceQuery.mockResolvedValue([{ total: '7777' }]);

      await expect(service.getGlobalUsage()).resolves.toBe(7777);

      const [sql] = dataSourceQuery.mock.calls[0] as [string];
      expect(sql).toContain('note_attachments');
      expect(sql).not.toContain('user_id = $1');
    });

    it('S8) 🔴 getNearCapUserCount SQL 에 note_attachments 두 컬럼이 UNION 돼 있다', async () => {
      const mockQuery = jest.fn().mockResolvedValue([{ count: '0' }]);
      (service as unknown as { dataSource: { query: jest.Mock } }).dataSource =
        { query: mockQuery };

      await service.getNearCapUserCount();

      const [sql] = mockQuery.mock.calls[0] as [string];
      expect(sql).toContain('file_size_bytes FROM note_attachments');
      expect(sql).toContain('strokes_size_bytes FROM note_attachments');
    });
  });

  /**
   * ── 출처별 분해 (breakdown) ────────────────────────────────────────────
   *
   * 노트 첨부가 100MB 풀에 합류한 뒤로 "용량 부족" 만으로는 **어디를 지워야 하는지**
   * 알 수 없다. 아래 시나리오를 먼저 나열하고 코드를 붙였다.
   *
   *  B1 myinfo 만 있음 → myinfoBytes 에만 잡힌다
   *  B2 노트만 있음 → noteImageBytes 에만 잡힌다
   *  B3 둘 다 → 각각 제 칸에 · 섞이지 않는다
   *  B4 경계 — 신규 사용자(둘 다 0)
   *  B5 경계 — strokes_size_bytes 가 채워지면 **노트 쪽**에 합산 (myinfo 로 새지 않는다)
   *  B6 🔴 불변식 — 모든 케이스에서 usedBytes === myinfoBytes + noteImageBytes
   *  B7 🔴 회귀 — cap 검증(assertWithinLimit)은 여전히 manager 로만 읽는다
   *     (분해 리팩터가 락 밖 읽기를 만들면 cap 이 뚫린다)
   *  B8 회귀 — calculateUsage 는 총량 number 를 그대로 반환 (호출부 무변경)
   */
  describe('breakdown (출처별 분해)', () => {
    /** myinfo 5테이블에 합계를 심는다 — 첫 repo 에 몰아주고 나머지는 0 */
    const seedMyinfo = (total: string) => {
      certRepo.createQueryBuilder.mockReturnValue(makeQb({ total }) as never);
      [awardRepo, langCertRepo, docRepo, eduRepo].forEach((r) =>
        r.createQueryBuilder.mockReturnValue(makeQb({ total: '0' }) as never),
      );
    };

    it('B1·B6) myinfo 만 있음 → myinfoBytes 에만 · 합 일치', async () => {
      seedMyinfo('3000');
      dataSourceQuery.mockResolvedValue([{ total: '0' }]);

      const usage = await service.getUsage('user-1');

      expect(usage.breakdown).toEqual({
        myinfoBytes: 3000,
        noteImageBytes: 0,
      });
      expect(usage.usedBytes).toBe(
        usage.breakdown.myinfoBytes + usage.breakdown.noteImageBytes,
      );
    });

    it('B2·B6) 노트만 있음 → noteImageBytes 에만 · 합 일치', async () => {
      seedMyinfo('0');
      dataSourceQuery.mockResolvedValue([{ total: '4096' }]);

      const usage = await service.getUsage('user-1');

      expect(usage.breakdown).toEqual({
        myinfoBytes: 0,
        noteImageBytes: 4096,
      });
      expect(usage.usedBytes).toBe(
        usage.breakdown.myinfoBytes + usage.breakdown.noteImageBytes,
      );
    });

    it('B3·B6) 둘 다 있음 → 각각 제 칸에 · 합 일치', async () => {
      certRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '1000' }) as never,
      );
      awardRepo.createQueryBuilder.mockReturnValue(
        makeQb({ total: '2000' }) as never,
      );
      [langCertRepo, docRepo, eduRepo].forEach((r) =>
        r.createQueryBuilder.mockReturnValue(makeQb({ total: '0' }) as never),
      );
      dataSourceQuery.mockResolvedValue([{ total: '500' }]);

      const usage = await service.getUsage('user-1');

      expect(usage.breakdown).toEqual({
        myinfoBytes: 3000,
        noteImageBytes: 500,
      });
      expect(usage.usedBytes).toBe(3500);
      expect(usage.usedBytes).toBe(
        usage.breakdown.myinfoBytes + usage.breakdown.noteImageBytes,
      );
    });

    it('B4·B6) 경계 — 신규 사용자(둘 다 0) → 0/0 · 합 일치 · percentage 0', async () => {
      seedMyinfo('0');
      dataSourceQuery.mockResolvedValue([]);

      const usage = await service.getUsage('user-new');

      expect(usage.breakdown).toEqual({ myinfoBytes: 0, noteImageBytes: 0 });
      expect(usage.usedBytes).toBe(0);
      expect(usage.percentage).toBe(0);
    });

    it('B5·B6) 경계 — strokes_size_bytes 는 노트 쪽에 합산된다 (myinfo 로 안 샌다)', async () => {
      seedMyinfo('0');
      // 실 SQL 이 file + strokes 를 더해 한 값으로 돌려준다 (ATTACHMENT_SUM_SQL)
      const fileBytes = 8192;
      const strokeBytes = 1024;
      dataSourceQuery.mockResolvedValue([
        { total: String(fileBytes + strokeBytes) },
      ]);

      const usage = await service.getUsage('user-1');

      const [sql] = dataSourceQuery.mock.calls[0] as [string];
      expect(sql).toContain('file_size_bytes');
      expect(sql).toContain('strokes_size_bytes');
      expect(usage.breakdown.noteImageBytes).toBe(fileBytes + strokeBytes);
      expect(usage.breakdown.myinfoBytes).toBe(0);
      expect(usage.usedBytes).toBe(
        usage.breakdown.myinfoBytes + usage.breakdown.noteImageBytes,
      );
    });

    it('B6) 🔴 불변식 — cap 근처 큰 값에서도 usedBytes 는 두 값의 합', async () => {
      seedMyinfo(String(60 * 1024 * 1024));
      dataSourceQuery.mockResolvedValue([{ total: String(35 * 1024 * 1024) }]);

      const usage = await service.getUsage('user-1');

      expect(usage.usedBytes).toBe(
        usage.breakdown.myinfoBytes + usage.breakdown.noteImageBytes,
      );
      expect(usage.usedBytes).toBe(95 * 1024 * 1024);
      expect(usage.usedMB).toBe(95);
      expect(usage.percentage).toBe(95);
    });

    it('B7) 🔴 회귀 — assertWithinLimit 은 manager 로만 읽는다 (dataSource 미사용)', async () => {
      const managerQuery = jest.fn().mockResolvedValue([{ total: '1024' }]);
      const getRepository = jest.fn().mockReturnValue({
        createQueryBuilder: () => makeQb({ total: '1024' }),
      });
      const manager = {
        getRepository,
        query: managerQuery,
      } as unknown as EntityManager;

      await expect(
        service.assertWithinLimit('user-1', 1024, manager),
      ).resolves.toBeUndefined();

      // myinfo 5테이블 + 노트 첨부 1회 — 전부 manager 경유
      expect(getRepository).toHaveBeenCalledTimes(5);
      expect(managerQuery).toHaveBeenCalledTimes(1);
      expect(dataSourceQuery).not.toHaveBeenCalled();
      expect(certRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('B8) 회귀 — calculateUsage 는 총량 number 를 그대로 반환한다', async () => {
      seedMyinfo('1000');
      dataSourceQuery.mockResolvedValue([{ total: '500' }]);

      await expect(service.calculateUsage('user-1')).resolves.toBe(1500);
    });
  });
});
