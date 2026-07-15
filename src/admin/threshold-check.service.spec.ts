import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import type { Repository, SelectQueryBuilder } from 'typeorm';
import { DiscordNotifier } from '../common/discord-notifier';
import { LlmCallLog } from '../ai/entities/llm-call-log.entity';
import { AlertThresholdsService } from './alert-thresholds.service';
import { AlertHistory } from './entities/alert-history.entity';
import { AlertThresholds } from './entities/alert-thresholds.entity';
import { ThresholdCheckService } from './threshold-check.service';

/**
 * F6 PR 2 Phase 5.4 — ThresholdCheckService spec.
 *
 * 시나리오:
 * - tick: enabled=false → 모든 체크 skip
 * - checkDailyCost: 임계치 미만/초과·dedup
 * - checkHourlyErrorRate: 0건 분모 safe, ratio 계산
 * - checkVsYesterday: 어제 0 분모 safe, +200% 초과
 * - fireAlert: dedup 1시간 내 sent → skipped_dedup, 외엔 notify+history insert
 * - discord 실패 → history 'failed' 기록
 * - webhook 미설정 → 'skipped_no_webhook'
 */
describe('ThresholdCheckService', () => {
  let service: ThresholdCheckService;
  let logRepo: jest.Mocked<Repository<LlmCallLog>>;
  let historyRepo: jest.Mocked<Repository<AlertHistory>>;
  let thresholds: jest.Mocked<AlertThresholdsService>;
  let discord: jest.Mocked<DiscordNotifier>;

  function makeQb<T extends object>(
    raws: unknown[] = [],
    single: Record<string, string | number> | null = null,
    count = 0,
  ): SelectQueryBuilder<T> {
    return {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      having: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(raws),
      getRawMany: jest.fn().mockResolvedValue(raws),
      getRawOne: jest.fn().mockResolvedValue(single),
      getCount: jest.fn().mockResolvedValue(count),
    } as unknown as SelectQueryBuilder<T>;
  }

  beforeEach(async () => {
    logRepo = mock<Repository<LlmCallLog>>();
    historyRepo = mock<Repository<AlertHistory>>();
    thresholds = mock<AlertThresholdsService>();
    discord = mock<DiscordNotifier>();

    historyRepo.create.mockImplementation((d) => d as AlertHistory);
    historyRepo.save.mockResolvedValue({} as AlertHistory);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThresholdCheckService,
        { provide: getRepositoryToken(LlmCallLog), useValue: logRepo },
        { provide: getRepositoryToken(AlertHistory), useValue: historyRepo },
        { provide: AlertThresholdsService, useValue: thresholds },
        { provide: DiscordNotifier, useValue: discord },
      ],
    }).compile();
    service = module.get(ThresholdCheckService);
  });

  describe('tick', () => {
    it('enabled=false → 3종 체크 모두 skip', async () => {
      thresholds.get.mockResolvedValue({
        enabled: false,
        dailyCostThresholdUsd: 50,
        hourlyErrorRateThreshold: 0.1,
        vsYesterdayIncreaseThreshold: 200,
      } as AlertThresholds);
      await service.tick();
      expect(logRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('thresholds.get 실패 → 에러 swallow (cron 다음 tick 정상)', async () => {
      thresholds.get.mockRejectedValue(new Error('DB down'));
      await expect(service.tick()).resolves.toBeUndefined();
    });
  });

  describe('checkDailyCost', () => {
    it('임계치 미만 → skip (notify 미호출)', async () => {
      logRepo.createQueryBuilder.mockReturnValueOnce(
        makeQb<LlmCallLog>([], { cost: '10.00' }),
      );
      await service.checkDailyCost(50);
      expect(discord.notify).not.toHaveBeenCalled();
    });

    it('임계치 초과 → notify + history insert', async () => {
      logRepo.createQueryBuilder.mockReturnValueOnce(
        makeQb<LlmCallLog>([], { cost: '60.00' }),
      );
      historyRepo.createQueryBuilder.mockReturnValueOnce(
        makeQb<AlertHistory>([], null, 0),
      );
      discord.notify.mockResolvedValue('sent');
      await service.checkDailyCost(50);
      expect(discord.notify).toHaveBeenCalledTimes(1);
      expect(historyRepo.save).toHaveBeenCalled();
    });
  });

  describe('checkHourlyErrorRate', () => {
    it('total=0 → skip (분모 0 safe)', async () => {
      logRepo.createQueryBuilder.mockReturnValueOnce(
        makeQb<LlmCallLog>([], { total: '0', errors: '0' }),
      );
      await service.checkHourlyErrorRate(0.1);
      expect(discord.notify).not.toHaveBeenCalled();
    });

    it('ratio 10% 초과 → notify', async () => {
      logRepo.createQueryBuilder.mockReturnValueOnce(
        makeQb<LlmCallLog>([], { total: '100', errors: '20' }),
      );
      historyRepo.createQueryBuilder.mockReturnValueOnce(
        makeQb<AlertHistory>([], null, 0),
      );
      discord.notify.mockResolvedValue('sent');
      await service.checkHourlyErrorRate(0.1);
      expect(discord.notify).toHaveBeenCalled();
    });

    it('ratio 5% (임계치 10% 미만) → skip', async () => {
      logRepo.createQueryBuilder.mockReturnValueOnce(
        makeQb<LlmCallLog>([], { total: '100', errors: '5' }),
      );
      await service.checkHourlyErrorRate(0.1);
      expect(discord.notify).not.toHaveBeenCalled();
    });
  });

  describe('checkVsYesterday', () => {
    it('어제 0 → skip (분모 safe)', async () => {
      logRepo.createQueryBuilder
        .mockReturnValueOnce(makeQb<LlmCallLog>([], { cost: '50' }))
        .mockReturnValueOnce(makeQb<LlmCallLog>([], { cost: '0' }));
      await service.checkVsYesterday(200);
      expect(discord.notify).not.toHaveBeenCalled();
    });

    it('오늘 = 어제 (0% 증가) → skip', async () => {
      logRepo.createQueryBuilder
        .mockReturnValueOnce(makeQb<LlmCallLog>([], { cost: '10' }))
        .mockReturnValueOnce(makeQb<LlmCallLog>([], { cost: '10' }));
      await service.checkVsYesterday(200);
      expect(discord.notify).not.toHaveBeenCalled();
    });

    it('+300% 증가 (임계치 200%) → notify', async () => {
      logRepo.createQueryBuilder
        .mockReturnValueOnce(makeQb<LlmCallLog>([], { cost: '40' }))
        .mockReturnValueOnce(makeQb<LlmCallLog>([], { cost: '10' }));
      historyRepo.createQueryBuilder.mockReturnValueOnce(
        makeQb<AlertHistory>([], null, 0),
      );
      discord.notify.mockResolvedValue('sent');
      await service.checkVsYesterday(200);
      expect(discord.notify).toHaveBeenCalled();
    });
  });

  describe('fireAlert', () => {
    it('dedup 1시간 내 sent 있음 → skipped_dedup (notify 미호출)', async () => {
      historyRepo.createQueryBuilder.mockReturnValueOnce(
        makeQb<AlertHistory>([], null, 1),
      );
      const result = await service.fireAlert(
        'daily_cost',
        60,
        50,
        'test message',
      );
      expect(result).toBe('skipped_dedup');
      expect(discord.notify).not.toHaveBeenCalled();
      expect(historyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ webhookStatus: 'skipped_dedup' }),
      );
    });

    it('dedup 통과 → notify + history "sent" insert', async () => {
      historyRepo.createQueryBuilder.mockReturnValueOnce(
        makeQb<AlertHistory>([], null, 0),
      );
      discord.notify.mockResolvedValue('sent');
      const result = await service.fireAlert(
        'daily_cost',
        60,
        50,
        'test message',
      );
      expect(result).toBe('sent');
      expect(historyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ webhookStatus: 'sent' }),
      );
    });

    it('discord notify failed → history "failed" insert (best-effort)', async () => {
      historyRepo.createQueryBuilder.mockReturnValueOnce(
        makeQb<AlertHistory>([], null, 0),
      );
      discord.notify.mockResolvedValue('failed');
      const result = await service.fireAlert(
        'hourly_error_rate',
        0.5,
        0.1,
        'fail test',
      );
      expect(result).toBe('failed');
      expect(historyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ webhookStatus: 'failed' }),
      );
    });

    it('webhook 미설정 → "skipped_no_webhook" history', async () => {
      historyRepo.createQueryBuilder.mockReturnValueOnce(
        makeQb<AlertHistory>([], null, 0),
      );
      discord.notify.mockResolvedValue('skipped_no_webhook');
      const result = await service.fireAlert(
        'vs_yesterday',
        300,
        200,
        'no webhook',
      );
      expect(result).toBe('skipped_no_webhook');
      expect(historyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ webhookStatus: 'skipped_no_webhook' }),
      );
    });
  });

  // ── 웨이브 D — 코인 차감 feature 이상 사용 감시 ──
  describe('checkAbnormalCoinUsage', () => {
    it('임계 초과 유저 있음 → critical 알림 + abnormal_coin_usage history', async () => {
      logRepo.createQueryBuilder.mockReturnValueOnce(
        makeQb<LlmCallLog>([{ userId: 'u-1', calls: '250' }]),
      );
      historyRepo.createQueryBuilder.mockReturnValueOnce(
        makeQb<AlertHistory>([], null, 0),
      );
      discord.notify.mockResolvedValue('sent');
      await service.checkAbnormalCoinUsage(200);
      expect(discord.notify).toHaveBeenCalledTimes(1);
      expect(discord.notify).toHaveBeenCalledWith(
        expect.stringContaining('u-1'),
        'critical',
      );
      expect(historyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ alertType: 'abnormal_coin_usage' }),
      );
    });

    it('임계 초과 유저 없음 → 무알림', async () => {
      logRepo.createQueryBuilder.mockReturnValueOnce(makeQb<LlmCallLog>([]));
      await service.checkAbnormalCoinUsage(200);
      expect(discord.notify).not.toHaveBeenCalled();
      expect(historyRepo.save).not.toHaveBeenCalled();
    });

    it('1h dedup — 최근 sent 있으면 skipped_dedup (알림 생략)', async () => {
      logRepo.createQueryBuilder.mockReturnValueOnce(
        makeQb<LlmCallLog>([{ userId: 'u-1', calls: '300' }]),
      );
      historyRepo.createQueryBuilder.mockReturnValueOnce(
        makeQb<AlertHistory>([], null, 1), // 최근 1h sent 있음
      );
      await service.checkAbnormalCoinUsage(200);
      expect(discord.notify).not.toHaveBeenCalled();
      expect(historyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ webhookStatus: 'skipped_dedup' }),
      );
    });
  });

  describe('tick — abnormal_coin_usage 편입', () => {
    it('enabled=true → checkAbnormalCoinUsage 를 abuserSuspectDailyCalls 로 호출', async () => {
      thresholds.get.mockResolvedValue({
        enabled: true,
        dailyCostThresholdUsd: 50,
        hourlyErrorRateThreshold: 0.1,
        vsYesterdayIncreaseThreshold: 200,
        abuserSuspectDailyCalls: 200,
      } as AlertThresholds);
      // 3종은 spy 로 무력화 (query builder mock 불필요)
      jest.spyOn(service, 'checkDailyCost').mockResolvedValue();
      jest.spyOn(service, 'checkHourlyErrorRate').mockResolvedValue();
      jest.spyOn(service, 'checkVsYesterday').mockResolvedValue();
      const spy = jest
        .spyOn(service, 'checkAbnormalCoinUsage')
        .mockResolvedValue();
      await service.tick();
      expect(spy).toHaveBeenCalledWith(200);
    });
  });
});
