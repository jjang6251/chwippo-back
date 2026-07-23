import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import {
  QueryFailedError,
  type Repository,
  type SelectQueryBuilder,
} from 'typeorm';
import { AlertHistory } from '../admin/entities/alert-history.entity';
import { AlertThresholds } from '../admin/entities/alert-thresholds.entity';
import { DiscordNotifier } from '../common/discord-notifier';
import { LlmCallLog } from './entities/llm-call-log.entity';
import { ProviderOutageAlertService } from './provider-outage-alert.service';

/**
 * ProviderOutageAlertService spec — 제공사 장애 알림 판정.
 *
 * 시나리오 (task 알림 파트):
 * - ⑨ 10분 내 임계(3) 도달 → notifier 1회
 * - ⑩ 쿨다운 내 'sent' 존재 → 미발송
 * - 임계 미만 → 미발송
 * - enabled=false → 미발송 (kill switch)
 * - ⑫ notifier throw → best-effort (미throw)
 * - ⑬ dedup_key UNIQUE 충돌(동시 race) → 스킵·미throw
 * - 발송 실패(failed) → history webhook_status 정정
 */
describe('ProviderOutageAlertService', () => {
  let service: ProviderOutageAlertService;
  let logRepo: jest.Mocked<Repository<LlmCallLog>>;
  let historyRepo: jest.Mocked<Repository<AlertHistory>>;
  let thresholdRepo: jest.Mocked<Repository<AlertThresholds>>;
  let discord: jest.Mocked<DiscordNotifier>;

  function makeQb<T extends object>(
    single: Record<string, string | number> | null = null,
    count = 0,
  ): SelectQueryBuilder<T> {
    return {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue(single),
      getCount: jest.fn().mockResolvedValue(count),
    } as unknown as SelectQueryBuilder<T>;
  }

  const thresholds = (
    overrides: Partial<AlertThresholds> = {},
  ): AlertThresholds =>
    ({
      id: 1,
      enabled: true,
      aiOutageAlertCount10m: 3,
      aiOutageAlertCooldownMin: 30,
      ...overrides,
    }) as AlertThresholds;

  beforeEach(async () => {
    logRepo = mock<Repository<LlmCallLog>>();
    historyRepo = mock<Repository<AlertHistory>>();
    thresholdRepo = mock<Repository<AlertThresholds>>();
    discord = mock<DiscordNotifier>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProviderOutageAlertService,
        { provide: getRepositoryToken(LlmCallLog), useValue: logRepo },
        { provide: getRepositoryToken(AlertHistory), useValue: historyRepo },
        {
          provide: getRepositoryToken(AlertThresholds),
          useValue: thresholdRepo,
        },
        { provide: DiscordNotifier, useValue: discord },
      ],
    }).compile();
    service = module.get(ProviderOutageAlertService);
  });

  it('⑨ 10분 내 error 3건(임계 도달) + 쿨다운 없음 → notifier 1회 + history insert(dedup_key)', async () => {
    thresholdRepo.findOne.mockResolvedValue(thresholds());
    logRepo.createQueryBuilder.mockReturnValueOnce(
      makeQb<LlmCallLog>({ errors: '3', fallbacks: '1' }),
    );
    historyRepo.createQueryBuilder.mockReturnValueOnce(
      makeQb<AlertHistory>(null, 0),
    );
    discord.notify.mockResolvedValue('sent');

    await service.handleProviderOutage('anthropic', 'connection reset');

    expect(discord.notify).toHaveBeenCalledTimes(1);
    expect(discord.notify).toHaveBeenCalledWith(
      expect.stringContaining('anthropic'),
      'critical',
    );
    // fallback 발동 count 포함
    expect(discord.notify).toHaveBeenCalledWith(
      expect.stringContaining('fallback 발동 1건'),
      'critical',
    );
    expect(historyRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertType: 'provider_outage',
        webhookStatus: 'sent',
        dedupKey: expect.stringMatching(/^provider_outage:anthropic:\d+$/),
        triggeredValue: 3,
        thresholdValue: 3,
      }),
    );
  });

  it('임계 미만(2 < 3) → 미발송', async () => {
    thresholdRepo.findOne.mockResolvedValue(thresholds());
    logRepo.createQueryBuilder.mockReturnValueOnce(
      makeQb<LlmCallLog>({ errors: '2', fallbacks: '0' }),
    );
    await service.handleProviderOutage('openai', 'timeout');
    expect(discord.notify).not.toHaveBeenCalled();
    expect(historyRepo.insert).not.toHaveBeenCalled();
  });

  it('⑩ 쿨다운 내 동일 provider sent 존재 → 미발송', async () => {
    thresholdRepo.findOne.mockResolvedValue(thresholds());
    logRepo.createQueryBuilder.mockReturnValueOnce(
      makeQb<LlmCallLog>({ errors: '5', fallbacks: '2' }),
    );
    historyRepo.createQueryBuilder.mockReturnValueOnce(
      makeQb<AlertHistory>(null, 1), // 최근 30분 내 sent 1건
    );
    await service.handleProviderOutage('anthropic', 'err');
    expect(discord.notify).not.toHaveBeenCalled();
    expect(historyRepo.insert).not.toHaveBeenCalled();
  });

  it('enabled=false → kill switch, 조회 없이 미발송', async () => {
    thresholdRepo.findOne.mockResolvedValue(thresholds({ enabled: false }));
    await service.handleProviderOutage('anthropic', 'err');
    expect(logRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(discord.notify).not.toHaveBeenCalled();
  });

  it('⑫ notifier throw → best-effort (예외 미전파)', async () => {
    thresholdRepo.findOne.mockResolvedValue(thresholds());
    logRepo.createQueryBuilder.mockReturnValueOnce(
      makeQb<LlmCallLog>({ errors: '4', fallbacks: '0' }),
    );
    historyRepo.createQueryBuilder.mockReturnValueOnce(
      makeQb<AlertHistory>(null, 0),
    );
    discord.notify.mockRejectedValue(new Error('discord down'));
    await expect(
      service.handleProviderOutage('anthropic', 'err'),
    ).resolves.toBeUndefined();
  });

  it('⑬ dedup_key UNIQUE 충돌(동시 race) → 스킵·미throw·notifier 미호출', async () => {
    thresholdRepo.findOne.mockResolvedValue(thresholds());
    logRepo.createQueryBuilder.mockReturnValueOnce(
      makeQb<LlmCallLog>({ errors: '3', fallbacks: '0' }),
    );
    historyRepo.createQueryBuilder.mockReturnValueOnce(
      makeQb<AlertHistory>(null, 0),
    );
    const uniqueErr = new QueryFailedError('insert', [], {
      code: '23505',
    } as unknown as Error);
    historyRepo.insert.mockRejectedValue(uniqueErr);

    await expect(
      service.handleProviderOutage('anthropic', 'err'),
    ).resolves.toBeUndefined();
    // 슬롯 선점 실패 → 발송 안 함
    expect(discord.notify).not.toHaveBeenCalled();
  });

  it('발송 결과 failed → history webhook_status 정정(update)', async () => {
    thresholdRepo.findOne.mockResolvedValue(thresholds());
    logRepo.createQueryBuilder.mockReturnValueOnce(
      makeQb<LlmCallLog>({ errors: '3', fallbacks: '0' }),
    );
    historyRepo.createQueryBuilder.mockReturnValueOnce(
      makeQb<AlertHistory>(null, 0),
    );
    discord.notify.mockResolvedValue('failed');

    await service.handleProviderOutage('anthropic', 'err');
    expect(historyRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: expect.stringMatching(/^provider_outage:anthropic:\d+$/),
      }),
      { webhookStatus: 'failed' },
    );
  });

  it('Fix B — 대표 에러에 API 키 파편(sk-...) 포함 → Discord 메시지 마스킹', async () => {
    thresholdRepo.findOne.mockResolvedValue(thresholds());
    logRepo.createQueryBuilder.mockReturnValueOnce(
      makeQb<LlmCallLog>({ errors: '3', fallbacks: '0' }),
    );
    historyRepo.createQueryBuilder.mockReturnValueOnce(
      makeQb<AlertHistory>(null, 0),
    );
    discord.notify.mockResolvedValue('sent');

    await service.handleProviderOutage(
      'openai',
      'auth failed for key sk-live-ABCD1234efgh5678 rejected',
    );

    const sentMsg = discord.notify.mock.calls[0][0] as string;
    expect(sentMsg).toContain('sk-***');
    expect(sentMsg).not.toContain('sk-live-ABCD1234efgh5678');
  });

  it('thresholds row 없음 → 기본값(count 3·cooldown 30)으로 동작', async () => {
    thresholdRepo.findOne.mockResolvedValue(null);
    logRepo.createQueryBuilder.mockReturnValueOnce(
      makeQb<LlmCallLog>({ errors: '3', fallbacks: '0' }),
    );
    historyRepo.createQueryBuilder.mockReturnValueOnce(
      makeQb<AlertHistory>(null, 0),
    );
    discord.notify.mockResolvedValue('sent');
    await service.handleProviderOutage('openai', 'err');
    expect(discord.notify).toHaveBeenCalledTimes(1);
  });
});
