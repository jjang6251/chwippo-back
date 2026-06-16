import { Controller, Get, Logger, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { LlmCallLog } from '../ai/entities/llm-call-log.entity';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  ProviderHealthService,
  type ProviderHealth,
} from './provider-health.service';

const AUDIT_ERROR_THRESHOLD = 0.05; // 최근 1h error 5%+ → degraded

interface SystemStatus {
  backend: 'up';
  db: 'ok' | 'down';
  openai: ProviderHealth & { errorRateHint?: 'degraded' };
  anthropic: ProviderHealth & { errorRateHint?: 'degraded' };
}

/**
 * F6 PR 2 Phase 5.6.10 — system status (실제 ping + audit 추정 하이브리드).
 *
 * - backend: 응답 = up
 * - db: SELECT 1 atomic ping
 * - openai/anthropic: ProviderHealthCron 5분 캐시 (`lastPingedAt` 포함)
 * - audit 추정: 최근 1h `llm_call_logs.status='error'` 비율 5% 이상이면 `errorRateHint='degraded'`
 *   (cron ping 이 up 이라도 사용자 호출 결과가 안 좋으면 보조 신호)
 */
@Controller('admin/system-status')
@UseGuards(RolesGuard)
@Roles('admin')
export class SystemStatusController {
  private readonly logger = new Logger(SystemStatusController.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly providerHealth: ProviderHealthService,
    @InjectRepository(LlmCallLog)
    private readonly llmLogRepo: Repository<LlmCallLog>,
  ) {}

  @Get()
  async get(): Promise<SystemStatus> {
    let db: 'ok' | 'down' = 'down';
    try {
      await this.dataSource.query('SELECT 1');
      db = 'ok';
    } catch (err) {
      this.logger.warn(`DB ping failed: ${(err as Error).message}`);
    }

    const cached = this.providerHealth.getCached();
    const errorHints = await this.computeErrorRateHints();

    return {
      backend: 'up',
      db,
      openai: { ...cached.openai, ...errorHints.openai },
      anthropic: { ...cached.anthropic, ...errorHints.anthropic },
    };
  }

  /** 최근 1h status='error' 비율 ≥ 5% 인 provider 에 'degraded' 힌트 */
  private async computeErrorRateHints(): Promise<{
    openai: { errorRateHint?: 'degraded' };
    anthropic: { errorRateHint?: 'degraded' };
  }> {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const rows = await this.llmLogRepo
      .createQueryBuilder('l')
      .select('l.provider', 'provider')
      .addSelect('COUNT(*)', 'total')
      .addSelect("COUNT(*) FILTER (WHERE l.status = 'error')", 'errors')
      .where('l.created_at >= :since', { since })
      .andWhere('l.provider IN (:...providers)', {
        providers: ['openai', 'anthropic'],
      })
      .groupBy('l.provider')
      .getRawMany<{ provider: string; total: string; errors: string }>();

    const result = {
      openai: {} as { errorRateHint?: 'degraded' },
      anthropic: {} as { errorRateHint?: 'degraded' },
    };
    for (const r of rows) {
      const total = Number(r.total);
      if (total === 0) continue;
      const ratio = Number(r.errors) / total;
      if (ratio >= AUDIT_ERROR_THRESHOLD) {
        if (r.provider === 'openai') result.openai.errorRateHint = 'degraded';
        if (r.provider === 'anthropic')
          result.anthropic.errorRateHint = 'degraded';
      }
    }
    return result;
  }
}
