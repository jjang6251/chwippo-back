import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import type Redis from 'ioredis';
import { Repository } from 'typeorm';
import { REDIS_CLIENT } from '../common/redis.provider';
import { User } from '../users/user.entity';
import { CoinService } from './coin.service';
import { CostGuardService } from './cost-guard.service';
import { LlmCallLog } from './entities/llm-call-log.entity';
import {
  CURRENT_AI_CONSENT_VERSION,
  LlmService,
  type LlmCallBlocked,
} from './llm.service';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAIProvider } from './providers/openai.provider';
import { ProviderOutageAlertService } from './provider-outage-alert.service';

/**
 * LlmService in-flight lock — Redis 공유 스토리지 경로 spec (웨이브 C 승격).
 *
 * 시나리오:
 * ⑤ NX 획득 성공 → 진행 + 완료 시 DEL
 * ⑥ NX 실패(이미 잠김) → blocked (기존 blocked_quota·ALREADY_RUNNING·audit 동일), DEL 미호출
 * ⑦ Redis 에러 → in-memory Map 폴백으로 차단 유지 (fail-open 아님)
 * ⑧ REDIS_CLIENT 미주입(null) → 기존 Map 경로 그대로 (회귀 0)
 * ⑨ 성공·에러 양 경로 모두 DEL (lock leak 방지)
 *
 * (Map 경로 자체 동작은 llm.service.spec.ts '웨이브 C — in-flight lock' 에서 커버.)
 */
describe('LlmService — Redis in-flight lock', () => {
  const IN_FLIGHT_TTL_MS = 2 * 60 * 1000;
  const OK_RESULT = {
    text: 'ok',
    promptTokens: 10,
    completionTokens: 5,
    finishReason: 'stop',
  };
  const CALL_INPUT = {
    userId: 'u-1',
    feature: 'note_summary' as const,
    systemPrompt: 's',
    userPrompt: 'u',
  };
  const REDIS_KEY = 'llm:inflight:u-1:note_summary';

  let openai: {
    name: 'openai';
    isAvailable: boolean;
    complete: jest.Mock;
    callJson: jest.Mock;
  };
  let anthropic: typeof openai;
  let logRepo: jest.Mocked<Repository<LlmCallLog>>;
  let redis: jest.Mocked<Redis>;

  const makeUser = (): User =>
    ({
      id: 'u-1',
      nickname: '장성원',
      aiConsentAt: new Date(),
      aiConsentVersion: CURRENT_AI_CONSENT_VERSION,
    }) as unknown as User;

  const makeLog = (overrides: Partial<LlmCallLog> = {}): LlmCallLog =>
    ({
      id: 'log-' + Math.random().toString(36).slice(2, 8),
      status: 'ok',
      errorMessage: null,
      ...overrides,
    }) as unknown as LlmCallLog;

  const build = async (withRedis: boolean): Promise<LlmService> => {
    openai = {
      name: 'openai',
      isAvailable: true,
      complete: jest.fn(),
      callJson: jest.fn(),
    };
    // anthropic 은 fallback 후보 — isAvailable=false 로 두어 에러 시 fallback 미발동
    anthropic = {
      name: 'openai',
      isAvailable: false,
      complete: jest.fn(),
      callJson: jest.fn(),
    };

    const mockLogRepo = mock<Repository<LlmCallLog>>();
    mockLogRepo.create.mockImplementation((d) => d as LlmCallLog);
    mockLogRepo.save.mockImplementation(async (d) =>
      makeLog(d as Partial<LlmCallLog>),
    );

    const mockUserRepo = mock<Repository<User>>();
    mockUserRepo.findOne.mockResolvedValue(makeUser());

    const config = mock<ConfigService>();
    config.get.mockImplementation((key: string) => {
      if (key === 'OPENAI_MODEL_LIGHT') return 'gpt-4o-mini';
      if (key === 'OPENAI_MODEL_HEAVY') return 'gpt-4o';
      if (key === 'ANTHROPIC_MODEL_LIGHT') return 'claude-haiku-4-5-20251001';
      if (key === 'ANTHROPIC_MODEL_HEAVY') return 'claude-sonnet-4-6';
      return undefined;
    });

    const coinService = {
      // 코인 차감 feature → in-flight lock 활성화
      chargesCoins: jest.fn().mockResolvedValue(true),
      canCharge: jest.fn().mockResolvedValue({ ok: true }),
      charge: jest.fn().mockResolvedValue({
        coinCost: 0,
        costUsd: 0,
        breakdown: {
          input: 0,
          output: 0,
          cache_creation: 0,
          cache_read: 0,
          web_search: 0,
        },
      }),
    };
    const costGuard = {
      check: jest.fn().mockResolvedValue({ blocked: false }),
      invalidate: jest.fn(),
    };
    const outageAlert = { handleProviderOutage: jest.fn() };

    redis = mock<Redis>();

    const providers: Provider[] = [
      LlmService,
      { provide: OpenAIProvider, useValue: openai },
      { provide: AnthropicProvider, useValue: anthropic },
      { provide: getRepositoryToken(LlmCallLog), useValue: mockLogRepo },
      { provide: getRepositoryToken(User), useValue: mockUserRepo },
      { provide: ConfigService, useValue: config },
      { provide: CoinService, useValue: coinService },
      { provide: CostGuardService, useValue: costGuard },
      { provide: ProviderOutageAlertService, useValue: outageAlert },
    ];
    if (withRedis) providers.push({ provide: REDIS_CLIENT, useValue: redis });

    const module: TestingModule = await Test.createTestingModule({
      providers,
    }).compile();
    logRepo = module.get(getRepositoryToken(LlmCallLog));
    return module.get<LlmService>(LlmService);
  };

  it('⑤ NX 획득 성공 → 진행 + 완료 시 DEL', async () => {
    const service = await build(true);
    redis.set.mockResolvedValue('OK'); // 획득 성공
    redis.del.mockResolvedValue(1);
    openai.complete.mockResolvedValue(OK_RESULT);

    const r = await service.call({ ...CALL_INPUT });

    expect(r.status).toBe('ok');
    expect(redis.set).toHaveBeenCalledWith(
      REDIS_KEY,
      expect.any(String),
      'PX',
      IN_FLIGHT_TTL_MS,
      'NX',
    );
    expect(openai.complete).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith(REDIS_KEY);
  });

  it('⑥ NX 실패(이미 잠김) → blocked_quota + ALREADY_RUNNING + audit, provider·DEL 미호출', async () => {
    const service = await build(true);
    redis.set.mockResolvedValue(null); // 이미 잠김
    redis.del.mockResolvedValue(1);

    const r = await service.call({ ...CALL_INPUT });

    expect(r.status).toBe('blocked_quota');
    expect((r as LlmCallBlocked).code).toBe('ALREADY_RUNNING');
    expect(openai.complete).not.toHaveBeenCalled();
    // 획득 못했으므로 해제(DEL)도 안 함 (남의 lock 삭제 방지)
    expect(redis.del).not.toHaveBeenCalled();
    const blockedRow = logRepo.save.mock.calls
      .map((c) => c[0] as Partial<LlmCallLog>)
      .find((row) => row.errorMessage?.includes('ALREADY_RUNNING'));
    expect(blockedRow).toBeDefined();
    expect(blockedRow!.status).toBe('blocked_quota');
  });

  it('⑦ Redis 에러 → in-memory Map 폴백으로 차단 유지 (동시 2요청 = 1 ok + 1 blocked)', async () => {
    const service = await build(true);
    redis.set.mockRejectedValue(new Error('ECONNREFUSED')); // 획득 시 Redis 다운
    redis.del.mockRejectedValue(new Error('ECONNREFUSED'));

    let resolveProvider!: (v: unknown) => void;
    openai.complete.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveProvider = (val) => res(val);
        }),
    );
    openai.complete.mockResolvedValue(OK_RESULT);

    const p1 = service.call({ ...CALL_INPUT }); // Map 폴백으로 획득 + provider hang
    await new Promise((r) => setImmediate(r));

    const r2 = await service.call({ ...CALL_INPUT }); // Map 폴백 → 이미 있음 → 차단
    expect(r2.status).toBe('blocked_quota');
    expect((r2 as LlmCallBlocked).code).toBe('ALREADY_RUNNING');
    expect(openai.complete).toHaveBeenCalledTimes(1);

    resolveProvider(OK_RESULT);
    const r1 = await p1;
    expect(r1.status).toBe('ok');
  });

  it('⑧ REDIS_CLIENT 미주입(null) → 기존 Map 경로 (redis 미접근, 차단 정상)', async () => {
    const service = await build(false); // REDIS_CLIENT 미제공

    let resolveProvider!: (v: unknown) => void;
    openai.complete.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveProvider = (val) => res(val);
        }),
    );
    openai.complete.mockResolvedValue(OK_RESULT);

    const p1 = service.call({ ...CALL_INPUT });
    await new Promise((r) => setImmediate(r));
    const r2 = await service.call({ ...CALL_INPUT });

    expect(r2.status).toBe('blocked_quota'); // Map 경로 차단
    expect((r2 as LlmCallBlocked).code).toBe('ALREADY_RUNNING');
    // redis mock 은 주입 안 됐지만, build 가 만든 인스턴스는 접근되지 않아야 함
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();

    resolveProvider(OK_RESULT);
    await p1;
  });

  it('⑨ 에러 경로에서도 DEL 호출 (lock leak 방지)', async () => {
    const service = await build(true);
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
    // 400 = internal (non-recoverable) → fallback 미발동, 곧장 error 반환 후 finally 해제
    openai.complete.mockRejectedValue(
      Object.assign(new Error('bad request'), { status: 400 }),
    );

    const r = await service.call({ ...CALL_INPUT });

    expect(r.status).toBe('error');
    expect(redis.del).toHaveBeenCalledWith(REDIS_KEY); // 에러여도 해제됨
  });
});
