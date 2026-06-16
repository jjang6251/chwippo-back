import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ProviderHealthService,
  type ProviderHealth,
  type ProviderName,
} from './provider-health.service';
import { ThresholdCheckService } from './threshold-check.service';

/**
 * F6 PR 2 Phase 5.6.10 — provider health 5분 cron.
 *
 * - 2 provider 모두 ping → cache 갱신
 * - 직전 status 와 비교 → 변경 (up → down 등) 시 alert_history 'provider_down'/'provider_up' insert + Discord
 * - dedup — 같은 status 유지 시 alert 안 보냄
 * - 부팅 시 1회 즉시 ping (OnModuleInit) — 재시작 직후 5분간 'missing' 표시 방지
 */
@Injectable()
export class ProviderHealthCron implements OnModuleInit {
  private readonly logger = new Logger(ProviderHealthCron.name);
  private lastStatus: Record<ProviderName, ProviderHealth['status']> = {
    openai: 'missing',
    anthropic: 'missing',
  };

  constructor(
    private readonly health: ProviderHealthService,
    private readonly thresholdCheck: ThresholdCheckService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.tick();
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    try {
      await this.checkProvider('openai');
      await this.checkProvider('anthropic');
    } catch (err) {
      this.logger.error(`tick failed: ${(err as Error).message}`);
    }
  }

  async checkProvider(name: ProviderName): Promise<void> {
    const result =
      name === 'openai'
        ? await this.health.pingOpenAI()
        : await this.health.pingAnthropic();
    const prev = this.lastStatus[name];
    if (prev === result.status) return; // dedup
    // status 변경 detect
    const alertType =
      result.status === 'down' ? 'provider_down' : 'provider_up';
    const message =
      result.status === 'down'
        ? `🔴 ${name} down — ${result.reason ?? 'unknown'}`
        : `🟢 ${name} recovered (latency ${result.latencyMs ?? 0}ms)`;
    await this.thresholdCheck.fireAlert(
      alertType,
      result.latencyMs ?? 0,
      0,
      message,
    );
    this.lastStatus[name] = result.status;
  }
}
