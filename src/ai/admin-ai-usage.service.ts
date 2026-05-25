import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { LlmCallLog } from './entities/llm-call-log.entity';

export interface AiUsageQuery {
  startDate?: string; // ISO date
  endDate?: string;
  feature?: string;
}

export interface AiUsageRow {
  userId: string;
  totalCalls: number;
  totalCostUsd: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

export interface AiUsageSummary {
  totalCalls: number;
  totalCostUsd: number;
  byFeature: Array<{
    feature: string;
    calls: number;
    costUsd: number;
  }>;
  byStatus: Array<{ status: string; count: number }>;
}

@Injectable()
export class AdminAiUsageService {
  constructor(
    @InjectRepository(LlmCallLog)
    private readonly repo: Repository<LlmCallLog>,
  ) {}

  private parseRange(q: AiUsageQuery): { start: Date; end: Date } {
    const end = q.endDate ? new Date(q.endDate) : new Date();
    const start = q.startDate
      ? new Date(q.startDate)
      : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { start, end };
  }

  async overview(q: AiUsageQuery): Promise<AiUsageSummary> {
    const { start, end } = this.parseRange(q);
    const qb = this.repo
      .createQueryBuilder('l')
      .where('l.created_at BETWEEN :start AND :end', { start, end });
    if (q.feature) qb.andWhere('l.feature = :feature', { feature: q.feature });

    const total = await qb
      .select([
        'COUNT(*) AS calls',
        'COALESCE(SUM(l.cost_usd), 0) AS cost',
      ])
      .getRawOne<{ calls: string; cost: string }>();

    const byFeature = await this.repo
      .createQueryBuilder('l')
      .select('l.feature', 'feature')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COALESCE(SUM(l.cost_usd), 0)', 'cost')
      .where('l.created_at BETWEEN :start AND :end', { start, end })
      .groupBy('l.feature')
      .orderBy('cost', 'DESC')
      .getRawMany<{ feature: string; calls: string; cost: string }>();

    const byStatus = await this.repo
      .createQueryBuilder('l')
      .select('l.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('l.created_at BETWEEN :start AND :end', { start, end })
      .groupBy('l.status')
      .getRawMany<{ status: string; count: string }>();

    return {
      totalCalls: Number(total?.calls ?? 0),
      totalCostUsd: Number(total?.cost ?? 0),
      byFeature: byFeature.map((r) => ({
        feature: r.feature,
        calls: Number(r.calls),
        costUsd: Number(r.cost),
      })),
      byStatus: byStatus.map((r) => ({
        status: r.status,
        count: Number(r.count),
      })),
    };
  }

  async byUser(q: AiUsageQuery): Promise<AiUsageRow[]> {
    const { start, end } = this.parseRange(q);
    const qb = this.repo
      .createQueryBuilder('l')
      .select('l.user_id', 'userId')
      .addSelect('COUNT(*)', 'totalCalls')
      .addSelect('COALESCE(SUM(l.cost_usd), 0)', 'totalCostUsd')
      .addSelect('COALESCE(SUM(l.prompt_tokens), 0)', 'totalPromptTokens')
      .addSelect('COALESCE(SUM(l.completion_tokens), 0)', 'totalCompletionTokens')
      .where('l.created_at BETWEEN :start AND :end', { start, end })
      .groupBy('l.user_id')
      .orderBy('"totalCostUsd"', 'DESC');

    if (q.feature) qb.andWhere('l.feature = :feature', { feature: q.feature });

    const rows = await qb.getRawMany<{
      userId: string;
      totalCalls: string;
      totalCostUsd: string;
      totalPromptTokens: string;
      totalCompletionTokens: string;
    }>();

    return rows.map((r) => ({
      userId: r.userId,
      totalCalls: Number(r.totalCalls),
      totalCostUsd: Number(r.totalCostUsd),
      totalPromptTokens: Number(r.totalPromptTokens),
      totalCompletionTokens: Number(r.totalCompletionTokens),
    }));
  }

  async userDetail(userId: string, q: AiUsageQuery): Promise<LlmCallLog[]> {
    const { start, end } = this.parseRange(q);
    return this.repo.find({
      where: {
        userId,
        createdAt: Between(start, end),
      },
      order: { createdAt: 'DESC' },
      take: 500,
    });
  }
}
