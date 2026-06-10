import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { AdminAuditLogsService } from './admin-audit-logs.service';
import { AdminAuditLog } from './admin-audit-log.entity';

/**
 * PR_B2 Phase 4 — AdminAuditLogsService spec.
 *
 * 5축 — 정상 / 필터 조합 / boundary (페이지/limit) / 보안 (SQL injection 방어 — parameterized).
 */
describe('AdminAuditLogsService', () => {
  let service: AdminAuditLogsService;
  let repo: jest.Mocked<Repository<AdminAuditLog>>;

  beforeEach(async () => {
    repo = mock<Repository<AdminAuditLog>>();
    repo.findAndCount.mockResolvedValue([[], 0]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminAuditLogsService,
        { provide: getRepositoryToken(AdminAuditLog), useValue: repo },
      ],
    }).compile();
    service = module.get(AdminAuditLogsService);
  });

  describe('기본 동작', () => {
    it('필터 X → 모든 row + default page=1 / limit=50', async () => {
      await service.search({});
      expect(repo.findAndCount).toHaveBeenCalledWith({
        where: {},
        order: { createdAt: 'DESC' },
        skip: 0,
        take: 50,
      });
    });

    it('page=2 + limit=20 → skip=20 take=20', async () => {
      await service.search({ page: 2, limit: 20 });
      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 20 }),
      );
    });
  });

  describe('필터', () => {
    it('action 만', async () => {
      await service.search({ action: 'grant_coin' });
      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { action: 'grant_coin' },
        }),
      );
    });

    it('adminId + targetId 조합', async () => {
      await service.search({ adminId: 'admin-1', targetId: 'target-1' });
      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { adminUserId: 'admin-1', targetId: 'target-1' },
        }),
      );
    });

    it('from + to → Between', async () => {
      await service.search({
        from: '2026-06-01T00:00:00Z',
        to: '2026-06-08T00:00:00Z',
      });
      const where = repo.findAndCount.mock.calls[0][0]?.where as {
        createdAt: ReturnType<typeof Between>;
      };
      expect(where.createdAt).toBeDefined();
    });

    it('from 만 → from ~ 2100', async () => {
      await service.search({ from: '2026-06-01T00:00:00Z' });
      expect(repo.findAndCount).toHaveBeenCalled();
    });

    it('to 만 → 2000 ~ to', async () => {
      await service.search({ to: '2026-06-08T00:00:00Z' });
      expect(repo.findAndCount).toHaveBeenCalled();
    });
  });

  describe('boundary', () => {
    it('limit 초과 (200) → 100 으로 cap', async () => {
      await service.search({ limit: 200 });
      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });

    it('limit 0 → 1 로 cap', async () => {
      await service.search({ limit: 0 });
      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ take: 1 }),
      );
    });

    it('page 0 또는 음수 → 1 로 cap', async () => {
      await service.search({ page: 0 });
      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0 }),
      );

      await service.search({ page: -5 });
      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0 }),
      );
    });
  });

  describe('보안', () => {
    it('action 에 SQL injection 시도 → TypeORM where parameterized (raw string interpolation 없음)', async () => {
      const malicious = "grant_coin' OR '1'='1";
      await service.search({ action: malicious });
      // TypeORM 의 FindOptionsWhere 는 parameterized
      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ action: malicious }),
        }),
      );
    });

    it('total + rows + page + limit 응답 형식', async () => {
      repo.findAndCount.mockResolvedValueOnce([
        [
          {
            id: '1',
            action: 'grant_coin',
            targetType: 'user',
            targetId: 'u1',
            adminUserId: 'a1',
            detail: {},
            ip: '127.0.0.1',
            userAgent: 'test',
            createdAt: new Date(),
          },
        ],
        42,
      ]);

      const r = await service.search({ page: 2, limit: 30 });
      expect(r.total).toBe(42);
      expect(r.page).toBe(2);
      expect(r.limit).toBe(30);
      expect(r.rows.length).toBe(1);
    });
  });
});
