import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, MoreThan, Repository } from 'typeorm';
import { CompanyResearchCache } from '../interview-prep/entities/company-research-cache.entity';
import { LlmCallLog } from '../ai/entities/llm-call-log.entity';

/**
 * PR_B2 Phase 4 — 회사조사 metrics (admin 운영 관점).
 *
 * - **Fill rate**: aiResearch 의 11 항목별 채워진 비율 (0 항목 = 부실 cache → 비용 낭비)
 * - **Cost trend**: 일별 company_research feature 의 cost 합계 (period 별)
 * - **Cache stats**: hit / miss / expired (TTL 90일 기준)
 * - **Top 10 회사**: hit_count desc — 자주 조회되는 회사 (인기 ranking)
 */
@Injectable()
export class CompanyResearchMetricsService {
  constructor(
    @InjectRepository(CompanyResearchCache)
    private readonly cacheRepo: Repository<CompanyResearchCache>,
    @InjectRepository(LlmCallLog)
    private readonly logRepo: Repository<LlmCallLog>,
  ) {}

  /** aiResearch 의 11 항목 — fill rate 계산 기준 (PRD 정의). */
  private readonly FILL_FIELDS = [
    'mission',
    'vision',
    'products',
    'culture',
    'recent_news',
    'tech_stack',
    'competitors',
    'financials',
    'hiring',
    'reviews',
    'media',
  ];

  /**
   * 11 항목별 fill rate (0~1). 전체 cache row 기준.
   * 빈 string·null·빈 배열·빈 객체 모두 unfilled 로 카운트.
   */
  async getFillRate(): Promise<
    Array<{ field: string; filled: number; total: number; rate: number }>
  > {
    const rows = await this.cacheRepo.find({ select: ['aiResearch'] });
    const total = rows.length;
    if (total === 0) {
      return this.FILL_FIELDS.map((field) => ({
        field,
        filled: 0,
        total: 0,
        rate: 0,
      }));
    }

    return this.FILL_FIELDS.map((field) => {
      const filled = rows.filter((r) => {
        const v = r.aiResearch?.[field];
        if (v === null || v === undefined || v === '') return false;
        if (Array.isArray(v) && v.length === 0) return false;
        if (typeof v === 'object' && Object.keys(v).length === 0) return false;
        return true;
      }).length;
      return { field, filled, total, rate: filled / total };
    });
  }

  /**
   * 일별 cost trend — company_research feature 만.
   * period 기본 = 최근 30일.
   */
  async getCostTrend(
    days = 30,
  ): Promise<Array<{ date: string; cost: number; calls: number }>> {
    const from = new Date(Date.now() - days * 86400000);
    const rows = await this.logRepo
      .createQueryBuilder('l')
      .select("DATE_TRUNC('day', l.created_at)", 'date')
      .addSelect('SUM(l.cost_usd)', 'cost')
      .addSelect('COUNT(*)', 'calls')
      .where('l.feature = :feature', { feature: 'company_research' })
      .andWhere('l.created_at >= :from', { from })
      .groupBy('date')
      .orderBy('date', 'ASC')
      .getRawMany<{ date: Date; cost: string; calls: string }>();
    return rows.map((r) => ({
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date,
      cost: parseFloat(r.cost ?? '0'),
      calls: parseInt(r.calls ?? '0', 10),
    }));
  }

  /**
   * Cache stats — hit (TTL 안) / miss (만료) / total + opt_out 별도.
   */
  async getCacheStats(): Promise<{
    total: number;
    active: number;
    expired: number;
    optOut: number;
  }> {
    const now = new Date();
    const [total, active, expired, optOut] = await Promise.all([
      this.cacheRepo.count(),
      this.cacheRepo.count({
        where: { expiresAt: MoreThan(now), optOut: false },
      }),
      this.cacheRepo.count({ where: { expiresAt: LessThan(now) } }),
      this.cacheRepo.count({ where: { optOut: true } }),
    ]);
    return { total, active, expired, optOut };
  }

  /** Top N (default 10) 회사 — hit_count desc. */
  async getTopCompanies(
    limit = 10,
  ): Promise<
    Array<{ companyName: string; hitCount: number; expiresAt: Date }>
  > {
    const cap = Math.min(100, Math.max(1, limit));
    const rows = await this.cacheRepo.find({
      order: { hitCount: 'DESC' },
      take: cap,
      select: ['companyName', 'hitCount', 'expiresAt'],
    });
    return rows.map((r) => ({
      companyName: r.companyName,
      hitCount: r.hitCount,
      expiresAt: r.expiresAt,
    }));
  }
}
