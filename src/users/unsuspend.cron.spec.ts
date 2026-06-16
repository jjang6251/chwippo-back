import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { UnsuspendCron } from './unsuspend.cron';
import { User } from './user.entity';
import { AdminAuditService } from '../admin/admin-audit.service';

/**
 * PR_B2 Phase 1.5 — UnsuspendCron 시나리오 매트릭스.
 *
 * S13 cron 실패 대비 (cron + lazy 양쪽). 매시간 만료 user 일괄 해제.
 */
describe('UnsuspendCron', () => {
  let cron: UnsuspendCron;
  let userRepo: jest.Mocked<Repository<User>>;
  let auditService: jest.Mocked<AdminAuditService>;

  beforeEach(() => {
    userRepo = mock<Repository<User>>();
    auditService = mock<AdminAuditService>();
    cron = new UnsuspendCron(userRepo, auditService);
  });

  it('빈 결과 — 만료 user 없음 → 작업 skip + audit 미발생', async () => {
    userRepo.find.mockResolvedValue([]);

    await cron.sweep();

    expect(userRepo.update).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('만료 user N명 → 각 user 3 컬럼 NULL + audit auto_unsuspend (adminId=NULL)', async () => {
    const expired = [
      {
        id: 'u-1',
        suspendExpiresAt: new Date('2026-05-01'),
      } as User,
      {
        id: 'u-2',
        suspendExpiresAt: new Date('2026-04-01'),
      } as User,
    ];
    userRepo.find.mockResolvedValue(expired);

    await cron.sweep();

    expect(userRepo.update).toHaveBeenCalledTimes(2);
    expect(userRepo.update).toHaveBeenNthCalledWith(
      1,
      { id: 'u-1' },
      { suspendedAt: null, suspendReason: null, suspendExpiresAt: null },
    );
    expect(auditService.log).toHaveBeenCalledTimes(2);
    expect(auditService.log).toHaveBeenNthCalledWith(
      1,
      null, // adminId = NULL (system 자동)
      'auto_unsuspend',
      'user',
      'u-1',
      expect.objectContaining({ trigger: 'cron' }),
    );
  });

  it('audit 의 expiredAt detail — user 의 expires_at 그대로 전달', async () => {
    const exp = new Date('2026-05-01T12:00:00Z');
    userRepo.find.mockResolvedValue([
      { id: 'u-1', suspendExpiresAt: exp } as User,
    ]);

    await cron.sweep();

    expect(auditService.log).toHaveBeenCalledWith(
      null,
      'auto_unsuspend',
      'user',
      'u-1',
      { trigger: 'cron', expiredAt: exp },
    );
  });
});
