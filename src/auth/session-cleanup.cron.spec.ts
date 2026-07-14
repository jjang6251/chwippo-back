import { Test, TestingModule } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import { SessionCleanupCron } from './session-cleanup.cron';
import { AuthService } from './auth.service';

describe('SessionCleanupCron', () => {
  let cron: SessionCleanupCron;
  let authService: jest.Mocked<AuthService>;

  beforeEach(async () => {
    authService = mock<AuthService>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionCleanupCron,
        { provide: AuthService, useValue: authService },
      ],
    }).compile();
    cron = module.get(SessionCleanupCron);
  });

  it('만료·revoked 세션 + 소비 토큰 정리 호출', async () => {
    authService.deleteExpiredSessions.mockResolvedValue(7);
    authService.deleteUsedTokens.mockResolvedValue(4);

    await cron.sweep();

    expect(authService.deleteExpiredSessions).toHaveBeenCalledTimes(1);
    expect(authService.deleteUsedTokens).toHaveBeenCalledTimes(1);
  });

  it('삭제 중 에러가 나도 throw 하지 않음 (cron 안정성)', async () => {
    authService.deleteExpiredSessions.mockRejectedValue(new Error('db down'));

    await expect(cron.sweep()).resolves.toBeUndefined();
  });
});
