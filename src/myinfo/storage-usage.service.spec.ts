import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
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

  beforeEach(async () => {
    certRepo = mock<Repository<Cert>>();
    awardRepo = mock<Repository<Award>>();
    langCertRepo = mock<Repository<LanguageCert>>();
    docRepo = mock<Repository<Document>>();
    eduRepo = mock<Repository<Education>>();
    configGet = jest.fn().mockReturnValue(100); // 기본 100MB

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageUsageService,
        { provide: getRepositoryToken(Cert), useValue: certRepo },
        { provide: getRepositoryToken(Award), useValue: awardRepo },
        { provide: getRepositoryToken(LanguageCert), useValue: langCertRepo },
        { provide: getRepositoryToken(Document), useValue: docRepo },
        { provide: getRepositoryToken(Education), useValue: eduRepo },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: getDataSourceToken(), useValue: { query: jest.fn() } },
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
});
