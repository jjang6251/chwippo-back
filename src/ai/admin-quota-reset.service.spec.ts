import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import type { Repository } from 'typeorm';
import { AdminAuditService } from '../admin/admin-audit.service';
import { User } from '../users/user.entity';
import { AdminQuotaResetService } from './admin-quota-reset.service';
import { UserAiQuota } from './entities/user-ai-quota.entity';

describe('AdminQuotaResetService (5.6.9)', () => {
  let service: AdminQuotaResetService;
  let quotaRepo: jest.Mocked<Repository<UserAiQuota>>;
  let userRepo: jest.Mocked<Repository<User>>;
  let audit: jest.Mocked<AdminAuditService>;

  const ADMIN_ID = 'admin-1';

  beforeEach(async () => {
    quotaRepo = mock<Repository<UserAiQuota>>();
    userRepo = mock<Repository<User>>();
    audit = mock<AdminAuditService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminQuotaResetService,
        { provide: getRepositoryToken(UserAiQuota), useValue: quotaRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: AdminAuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(AdminQuotaResetService);
  });

  it('5) reset({userId=undefined}) → 전체 사용자 raw UPDATE + 누락 user INSERT + scope=all_users', async () => {
    const emQuery = jest
      .fn()
      .mockResolvedValueOnce([{ user_id: 'a' }, { user_id: 'b' }])
      .mockResolvedValueOnce([{ user_id: 'c' }]);
    const transactionFn = jest
      .fn()
      .mockImplementation(async (cb: (em: { query: jest.Mock }) => unknown) =>
        cb({ query: emQuery }),
      );
    Object.defineProperty(quotaRepo, 'manager', {
      value: { transaction: transactionFn },
      configurable: true,
    });
    const r = await service.reset(ADMIN_ID, {});
    expect(r.scope).toBe('all_users');
    expect(r.affected).toBe(3);
    expect(transactionFn).toHaveBeenCalledTimes(1);
    expect(emQuery).toHaveBeenCalledTimes(2);
    expect(emQuery.mock.calls[0][0]).toMatch(/UPDATE/);
    expect(emQuery.mock.calls[1][0]).toMatch(/INSERT/);
  });

  it('5-tx) 트랜잭션 안 INSERT 실패 → 전체 rollback (audit 도 호출 안 됨)', async () => {
    const emQuery = jest
      .fn()
      .mockResolvedValueOnce([{ user_id: 'a' }])
      .mockRejectedValueOnce(new Error('insert fail'));
    const transactionFn = jest
      .fn()
      .mockImplementation(async (cb: (em: { query: jest.Mock }) => unknown) =>
        cb({ query: emQuery }),
      );
    Object.defineProperty(quotaRepo, 'manager', {
      value: { transaction: transactionFn },
      configurable: true,
    });
    await expect(service.reset(ADMIN_ID, {})).rejects.toThrow('insert fail');
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('6) reset({userId="u-1"}) + row 있음 → 그 user UPDATE + scope=single_user', async () => {
    quotaRepo.findOne.mockResolvedValue({
      userId: 'u-1',
      quotaResetAt: {},
    } as UserAiQuota);
    quotaRepo.save.mockImplementation(async (r) => r as UserAiQuota);
    userRepo.findOne.mockResolvedValue({ id: 'u-1' } as User);
    const r = await service.reset(ADMIN_ID, { userId: 'u-1' });
    expect(r.scope).toBe('single_user');
    expect(r.affected).toBe(1);
    expect(quotaRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-1',
        quotaResetAt: expect.objectContaining({ '*': expect.any(String) }),
      }),
    );
  });

  it('7) reset({userId="u-1"}) + row 없음 → user 존재 검증 후 INSERT (upsert)', async () => {
    quotaRepo.findOne.mockResolvedValue(null);
    userRepo.findOne.mockResolvedValue({ id: 'u-1' } as User);
    quotaRepo.create.mockImplementation((d) => d as UserAiQuota);
    quotaRepo.save.mockImplementation(async (r) => r as UserAiQuota);
    const r = await service.reset(ADMIN_ID, { userId: 'u-1' });
    expect(r.scope).toBe('single_user');
    expect(r.affected).toBe(1);
    expect(quotaRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-1',
        quotaResetAt: expect.objectContaining({ '*': expect.any(String) }),
      }),
    );
  });

  it('8) reset 후 audit.log("reset_ai_quota", ...) 호출 (scope + affected detail)', async () => {
    const emQuery = jest
      .fn()
      .mockResolvedValueOnce([
        { user_id: 'a' },
        { user_id: 'b' },
        { user_id: 'c' },
      ])
      .mockResolvedValueOnce([]);
    const transactionFn = jest
      .fn()
      .mockImplementation(async (cb: (em: { query: jest.Mock }) => unknown) =>
        cb({ query: emQuery }),
      );
    Object.defineProperty(quotaRepo, 'manager', {
      value: { transaction: transactionFn },
      configurable: true,
    });
    await service.reset(ADMIN_ID, {});
    expect(audit.log).toHaveBeenCalledWith(
      ADMIN_ID,
      'reset_ai_quota',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        scope: 'all_users',
        affected: 3,
      }),
    );
  });

  it('9) reset({userId="u-x"}) + user 없음 → NotFoundException', async () => {
    quotaRepo.findOne.mockResolvedValue(null);
    userRepo.findOne.mockResolvedValue(null);
    await expect(service.reset(ADMIN_ID, { userId: 'u-x' })).rejects.toThrow(
      /사용자/,
    );
  });
});
