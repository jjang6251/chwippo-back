import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import { ProviderHealthService } from './provider-health.service';

/**
 * F6 PR 2 Phase 5.6.10 — ProviderHealthService 매트릭스 1-5.
 */
describe('ProviderHealthService', () => {
  let service: ProviderHealthService;
  let config: jest.Mocked<ConfigService>;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    config = mock<ConfigService>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProviderHealthService,
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = module.get(ProviderHealthService);
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => fetchSpy.mockRestore());

  it('1) OpenAI key 있음 + 200 응답 → status=up + latencyMs', async () => {
    config.get.mockReturnValue('sk-test');
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    const r = await service.pingOpenAI();
    expect(r.status).toBe('up');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.lastPingedAt).toBeTruthy();
  });

  it('2) OpenAI key 있음 + 4xx 응답 → status=down + HTTP reason', async () => {
    config.get.mockReturnValue('sk-test');
    fetchSpy.mockResolvedValue({ ok: false, status: 401 });
    const r = await service.pingOpenAI();
    expect(r.status).toBe('down');
    expect(r.reason).toContain('401');
  });

  it('3) OpenAI key 있음 + timeout → status=down + timeout reason', async () => {
    config.get.mockReturnValue('sk-test');
    fetchSpy.mockRejectedValue(new Error('The operation timed out'));
    const r = await service.pingOpenAI();
    expect(r.status).toBe('down');
    expect(r.reason).toMatch(/timeout/i);
  });

  it('4) OpenAI key 없음 → status=missing (ping X)', async () => {
    config.get.mockReturnValue(undefined);
    const r = await service.pingOpenAI();
    expect(r.status).toBe('missing');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('5-a) Anthropic key 있음 + 200 → up (x-api-key header)', async () => {
    config.get.mockReturnValue('sk-ant-test');
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    const r = await service.pingAnthropic();
    expect(r.status).toBe('up');
    const call = fetchSpy.mock.calls[0];
    expect(call[1].headers).toMatchObject({
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
    });
  });

  it('5-b) Anthropic key 없음 → missing', async () => {
    config.get.mockReturnValue(undefined);
    const r = await service.pingAnthropic();
    expect(r.status).toBe('missing');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
