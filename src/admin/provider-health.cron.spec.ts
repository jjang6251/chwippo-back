import { Test, TestingModule } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import { ProviderHealthCron } from './provider-health.cron';
import { ProviderHealthService } from './provider-health.service';
import { ThresholdCheckService } from './threshold-check.service';

/**
 * F6 PR 2 Phase 5.6.10 — ProviderHealthCron 매트릭스 6-8.
 */
describe('ProviderHealthCron', () => {
  let cron: ProviderHealthCron;
  let health: jest.Mocked<ProviderHealthService>;
  let thresholdCheck: jest.Mocked<ThresholdCheckService>;

  beforeEach(async () => {
    health = mock<ProviderHealthService>();
    thresholdCheck = mock<ThresholdCheckService>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProviderHealthCron,
        { provide: ProviderHealthService, useValue: health },
        { provide: ThresholdCheckService, useValue: thresholdCheck },
      ],
    }).compile();
    cron = module.get(ProviderHealthCron);
  });

  it('6) tick → 2 provider 모두 ping', async () => {
    health.pingOpenAI.mockResolvedValue({
      status: 'missing',
      latencyMs: null,
      reason: null,
      lastPingedAt: null,
    });
    health.pingAnthropic.mockResolvedValue({
      status: 'missing',
      latencyMs: null,
      reason: null,
      lastPingedAt: null,
    });
    await cron.tick();
    expect(health.pingOpenAI).toHaveBeenCalledTimes(1);
    expect(health.pingAnthropic).toHaveBeenCalledTimes(1);
  });

  it('7) status 변경 (missing → up) → fireAlert provider_up', async () => {
    health.pingOpenAI.mockResolvedValue({
      status: 'up',
      latencyMs: 80,
      reason: null,
      lastPingedAt: new Date().toISOString(),
    });
    await cron.checkProvider('openai');
    expect(thresholdCheck.fireAlert).toHaveBeenCalledWith(
      'provider_up',
      80,
      0,
      expect.stringContaining('openai'),
    );
  });

  it('7-b) up → down → fireAlert provider_down + reason 포함', async () => {
    // 첫 ping = up
    health.pingOpenAI.mockResolvedValueOnce({
      status: 'up',
      latencyMs: 50,
      reason: null,
      lastPingedAt: new Date().toISOString(),
    });
    await cron.checkProvider('openai');
    thresholdCheck.fireAlert.mockClear();
    // 두번째 ping = down
    health.pingOpenAI.mockResolvedValueOnce({
      status: 'down',
      latencyMs: 5000,
      reason: 'HTTP 503',
      lastPingedAt: new Date().toISOString(),
    });
    await cron.checkProvider('openai');
    expect(thresholdCheck.fireAlert).toHaveBeenCalledWith(
      'provider_down',
      5000,
      0,
      expect.stringContaining('HTTP 503'),
    );
  });

  it('8-b) onModuleInit → tick 1회 즉시 실행 (부팅 시 ping)', async () => {
    health.pingOpenAI.mockResolvedValue({
      status: 'missing',
      latencyMs: null,
      reason: null,
      lastPingedAt: null,
    });
    health.pingAnthropic.mockResolvedValue({
      status: 'missing',
      latencyMs: null,
      reason: null,
      lastPingedAt: null,
    });
    await cron.onModuleInit();
    expect(health.pingOpenAI).toHaveBeenCalledTimes(1);
    expect(health.pingAnthropic).toHaveBeenCalledTimes(1);
  });

  it('8) status 동일 (up → up) → fireAlert 호출 X (dedup)', async () => {
    health.pingOpenAI.mockResolvedValue({
      status: 'up',
      latencyMs: 50,
      reason: null,
      lastPingedAt: new Date().toISOString(),
    });
    await cron.checkProvider('openai'); // 첫 호출 — missing → up (fireAlert 1번)
    thresholdCheck.fireAlert.mockClear();
    await cron.checkProvider('openai'); // 두번째 — up → up (dedup)
    expect(thresholdCheck.fireAlert).not.toHaveBeenCalled();
  });
});
