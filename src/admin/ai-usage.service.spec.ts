import { BadRequestException } from '@nestjs/common';
import { mock } from 'jest-mock-extended';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { AiUsageService } from './ai-usage.service';
import { LlmCallLog } from '../ai/entities/llm-call-log.entity';

/**
 * PR_B2 Phase 2 — AiUsageService 시나리오 매트릭스.
 *
 * Q14 일/주/월/분기/년 모두 + 전기 비교 + cache hit rate + error rate.
 */
describe('AiUsageService', () => {
  let service: AiUsageService;
  let logRepo: jest.Mocked<Repository<LlmCallLog>>;
  let qb: jest.Mocked<SelectQueryBuilder<LlmCallLog>>;

  beforeEach(() => {
    logRepo = mock<Repository<LlmCallLog>>();
    qb = mock<SelectQueryBuilder<LlmCallLog>>();
    qb.select.mockReturnThis();
    qb.where.mockReturnThis();
    qb.groupBy.mockReturnThis();
    qb.addGroupBy.mockReturnThis();
    qb.orderBy.mockReturnThis();
    qb.limit.mockReturnThis();
    qb.leftJoin.mockReturnThis();
    logRepo.createQueryBuilder.mockReturnValue(qb);
    service = new AiUsageService(logRepo);
  });

  describe('computeRange', () => {
    it('period=day default → 직전 1일', () => {
      const r = service.computeRange('day');
      expect(r.to.getTime() - r.from.getTime()).toBe(86400000);
    });

    it('period=week → 7일', () => {
      const r = service.computeRange('week');
      expect(r.to.getTime() - r.from.getTime()).toBe(7 * 86400000);
    });

    it('period=month → 1개월 (28-31일 변동)', () => {
      const r = service.computeRange('month');
      const days = (r.to.getTime() - r.from.getTime()) / 86400000;
      expect(days).toBeGreaterThanOrEqual(28);
      expect(days).toBeLessThanOrEqual(31);
    });

    it('period=quarter → 3개월', () => {
      const r = service.computeRange('quarter');
      const months =
        (r.to.getFullYear() - r.from.getFullYear()) * 12 +
        (r.to.getMonth() - r.from.getMonth());
      expect(months).toBe(3);
    });

    it('period=year → 1년', () => {
      const r = service.computeRange('year');
      expect(r.to.getFullYear() - r.from.getFullYear()).toBe(1);
    });

    it('from > to → BadRequestException', () => {
      const f = new Date('2026-06-08');
      const t = new Date('2026-06-01');
      expect(() => service.computeRange('day', f, t)).toThrow(
        BadRequestException,
      );
    });

    it('전기 동기 범위 = current 길이 만큼 past', () => {
      const f = new Date('2026-06-01');
      const t = new Date('2026-06-08'); // 7일
      const r = service.computeRange('week', f, t);
      const currentLen = r.to.getTime() - r.from.getTime();
      const previousLen = r.previousTo.getTime() - r.previousFrom.getTime();
      expect(previousLen).toBe(currentLen);
      expect(r.previousTo.getTime()).toBe(r.from.getTime());
    });
  });

  describe('getUsageMetrics', () => {
    it('invalid period → BadRequestException', async () => {
      await expect(service.getUsageMetrics('invalid' as 'day')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('정상 — current + previous 비교 (deltaPct 계산)', async () => {
      qb.getRawOne
        .mockResolvedValueOnce({
          cost_sum: '10.5',
          total_calls: '100',
          cache_hits: '30',
          errors: '5',
        })
        .mockResolvedValueOnce({
          cost_sum: '5.0',
          total_calls: '50',
          cache_hits: '10',
          errors: '2',
        });

      const r = await service.getUsageMetrics('day');

      expect(r.totalCostUsd).toBe(10.5);
      expect(r.totalCalls).toBe(100);
      expect(r.cacheHitRate).toBe(0.3);
      expect(r.errorRate).toBe(0.05);
      expect(r.delta.previousCostUsd).toBe(5);
      expect(r.delta.costDeltaPct).toBeCloseTo(110, 5); // (10.5 - 5) / 5 * 100
    });

    it('빈 데이터 — 0 안전 처리 (cacheHitRate=0, errorRate=0)', async () => {
      qb.getRawOne.mockResolvedValue({
        cost_sum: null,
        total_calls: '0',
        cache_hits: '0',
        errors: '0',
      });

      const r = await service.getUsageMetrics('day');

      expect(r.totalCostUsd).toBe(0);
      expect(r.cacheHitRate).toBe(0);
      expect(r.errorRate).toBe(0);
      expect(r.delta.costDeltaPct).toBe(0); // prev=0 + cur=0 → 0
    });

    it('previous=0 + current>0 → 100% delta (신규)', async () => {
      qb.getRawOne
        .mockResolvedValueOnce({
          cost_sum: '3.0',
          total_calls: '10',
          cache_hits: '0',
          errors: '0',
        })
        .mockResolvedValueOnce({
          cost_sum: '0',
          total_calls: '0',
          cache_hits: '0',
          errors: '0',
        });

      const r = await service.getUsageMetrics('day');

      expect(r.delta.costDeltaPct).toBe(100);
      expect(r.delta.callsDeltaPct).toBe(100);
    });

    it('error rate 정확 — errors/total', async () => {
      qb.getRawOne.mockResolvedValue({
        cost_sum: '5',
        total_calls: '20',
        cache_hits: '5',
        errors: '4',
      });

      const r = await service.getUsageMetrics('day');

      expect(r.errorRate).toBe(0.2);
      expect(r.cacheHitRate).toBe(0.25);
    });
  });

  describe('getTopUsers', () => {
    it('limit cap 100', async () => {
      qb.getRawMany.mockResolvedValue([]);
      await service.getTopUsers('day', 500);
      expect(qb.limit).toHaveBeenCalledWith(100);
    });

    it('정상 — parse cost·calls', async () => {
      qb.getRawMany.mockResolvedValue([
        {
          userId: 'u-1',
          nickname: 'A',
          totalCostUsd: '12.50',
          totalCalls: '50',
        },
        {
          userId: 'u-2',
          nickname: null,
          totalCostUsd: '5.0',
          totalCalls: '20',
        },
      ]);

      const r = await service.getTopUsers('week', 20);

      expect(r).toEqual([
        { userId: 'u-1', nickname: 'A', totalCostUsd: 12.5, totalCalls: 50 },
        { userId: 'u-2', nickname: null, totalCostUsd: 5, totalCalls: 20 },
      ]);
    });
  });

  describe('getByFeature / getByModel', () => {
    it('getByFeature — feature 별 group + cost desc', async () => {
      qb.getRawMany.mockResolvedValue([
        {
          feature: 'company_research',
          totalCostUsd: '20.5',
          totalCalls: '100',
        },
      ]);

      const r = await service.getByFeature('month');

      expect(qb.groupBy).toHaveBeenCalledWith('log.feature');
      expect(r[0].feature).toBe('company_research');
      expect(r[0].totalCostUsd).toBe(20.5);
    });

    it('getByModel — model 별 group', async () => {
      qb.getRawMany.mockResolvedValue([
        { model: 'claude-haiku-4-5', totalCostUsd: '15', totalCalls: '50' },
      ]);

      const r = await service.getByModel('month');

      expect(qb.groupBy).toHaveBeenCalledWith('log.model');
      expect(r[0].model).toBe('claude-haiku-4-5');
    });
  });
});
