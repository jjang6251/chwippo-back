import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { DataSource } from 'typeorm';
import type { Repository, SelectQueryBuilder } from 'typeorm';
import { Reflector } from '@nestjs/core';
import { LlmCallLog } from '../ai/entities/llm-call-log.entity';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { ProviderHealthService } from './provider-health.service';
import { SystemStatusController } from './system-status.controller';

describe('SystemStatusController (5.6.10)', () => {
  let controller: SystemStatusController;
  let dataSource: jest.Mocked<DataSource>;
  let providerHealth: jest.Mocked<ProviderHealthService>;
  let llmLogRepo: jest.Mocked<Repository<LlmCallLog>>;
  const reflector = new Reflector();

  function makeQb<T extends object>(raws: unknown[] = []) {
    return {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(raws),
    } as unknown as SelectQueryBuilder<T>;
  }

  beforeEach(async () => {
    dataSource = mock<DataSource>();
    providerHealth = mock<ProviderHealthService>();
    providerHealth.getCached.mockReturnValue({
      openai: {
        status: 'missing',
        latencyMs: null,
        reason: null,
        lastPingedAt: null,
      },
      anthropic: {
        status: 'missing',
        latencyMs: null,
        reason: null,
        lastPingedAt: null,
      },
    });
    llmLogRepo = mock<Repository<LlmCallLog>>();
    llmLogRepo.createQueryBuilder.mockReturnValue(makeQb<LlmCallLog>([]));

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SystemStatusController],
      providers: [
        { provide: DataSource, useValue: dataSource },
        { provide: ProviderHealthService, useValue: providerHealth },
        { provide: getRepositoryToken(LlmCallLog), useValue: llmLogRepo },
      ],
    }).compile();
    controller = module.get(SystemStatusController);
  });

  it('admin role 가드 적용', () => {
    const roles = reflector.get<string[]>(ROLES_KEY, SystemStatusController);
    expect(roles).toEqual(['admin']);
  });

  it('9) DB ping 성공 + provider cache up → 응답에 lastPingedAt + latencyMs 포함', async () => {
    (dataSource.query as jest.Mock).mockResolvedValue([{ '?column?': 1 }]);
    providerHealth.getCached.mockReturnValue({
      openai: {
        status: 'up',
        latencyMs: 80,
        reason: null,
        lastPingedAt: '2026-05-29T03:00:00Z',
      },
      anthropic: {
        status: 'up',
        latencyMs: 120,
        reason: null,
        lastPingedAt: '2026-05-29T03:00:00Z',
      },
    });
    const result = await controller.get();
    expect(result.backend).toBe('up');
    expect(result.db).toBe('ok');
    expect(result.openai.status).toBe('up');
    expect(result.openai.latencyMs).toBe(80);
    expect(result.openai.lastPingedAt).toBe('2026-05-29T03:00:00Z');
    expect(result.anthropic.status).toBe('up');
  });

  it('10) cron 가 아직 안 돌았음 → cache=missing (fallback)', async () => {
    (dataSource.query as jest.Mock).mockResolvedValue([{ '?column?': 1 }]);
    // default mock = missing
    const result = await controller.get();
    expect(result.openai.status).toBe('missing');
    expect(result.anthropic.status).toBe('missing');
  });

  it('11) audit 추정 — 최근 1h openai error 5%+ → errorRateHint=degraded', async () => {
    (dataSource.query as jest.Mock).mockResolvedValue([{ '?column?': 1 }]);
    llmLogRepo.createQueryBuilder.mockReturnValue(
      makeQb<LlmCallLog>([
        { provider: 'openai', total: '100', errors: '10' }, // 10% > 5%
        { provider: 'anthropic', total: '50', errors: '1' }, // 2% < 5%
      ]),
    );
    const result = await controller.get();
    expect(result.openai.errorRateHint).toBe('degraded');
    expect(result.anthropic.errorRateHint).toBeUndefined();
  });

  it('DB ping 실패 → db=down (swallow, backend 응답 정상)', async () => {
    (dataSource.query as jest.Mock).mockRejectedValue(new Error('DB down'));
    const result = await controller.get();
    expect(result.db).toBe('down');
    expect(result.backend).toBe('up');
  });
});
