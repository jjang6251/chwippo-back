import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type ProviderName = 'openai' | 'anthropic';
export type ProviderStatus = 'up' | 'down' | 'missing';

export interface ProviderHealth {
  status: ProviderStatus;
  latencyMs: number | null;
  reason: string | null;
  lastPingedAt: string | null;
}

const PING_TIMEOUT_MS = 5_000;

/**
 * F6 PR 2 Phase 5.6.10 — OpenAI/Anthropic 실제 ping (`/v1/models`).
 *
 * - `/v1/models` 는 토큰 0 + rate limit 관대 → 5분마다 호출해도 안전.
 * - 결과는 in-memory 캐시. SystemStatusController 가 조회.
 * - cron (ProviderHealthCron) 가 주기 호출 → status 변경 시 alert_history insert.
 *
 * key 없음 → 'missing' (ping X). 즉시 반환.
 */
@Injectable()
export class ProviderHealthService {
  private readonly logger = new Logger(ProviderHealthService.name);
  private cache: Record<ProviderName, ProviderHealth> = {
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
  };

  constructor(private readonly config: ConfigService) {}

  /** 캐시 조회 (외부 호출 X) */
  getCached(): Record<ProviderName, ProviderHealth> {
    return { ...this.cache };
  }

  /** OpenAI ping — /v1/models 호출, 200 = up, 4xx/5xx/timeout = down */
  async pingOpenAI(): Promise<ProviderHealth> {
    const key = this.config.get<string>('OPENAI_API_KEY');
    if (!key) {
      this.cache.openai = {
        status: 'missing',
        latencyMs: null,
        reason: null,
        lastPingedAt: new Date().toISOString(),
      };
      return this.cache.openai;
    }
    const result = await this.fetchPing(
      'https://api.openai.com/v1/models',
      `Bearer ${key}`,
    );
    this.cache.openai = result;
    return result;
  }

  /** Anthropic ping — /v1/models 호출 */
  async pingAnthropic(): Promise<ProviderHealth> {
    const key = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!key) {
      this.cache.anthropic = {
        status: 'missing',
        latencyMs: null,
        reason: null,
        lastPingedAt: new Date().toISOString(),
      };
      return this.cache.anthropic;
    }
    const result = await this.fetchPing(
      'https://api.anthropic.com/v1/models',
      undefined,
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    );
    this.cache.anthropic = result;
    return result;
  }

  private async fetchPing(
    url: string,
    authHeader?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<ProviderHealth> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (authHeader) headers.Authorization = authHeader;
    const start = Date.now();
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      const latencyMs = Date.now() - start;
      if (res.ok) {
        return {
          status: 'up',
          latencyMs,
          reason: null,
          lastPingedAt: new Date().toISOString(),
        };
      }
      return {
        status: 'down',
        latencyMs,
        reason: `HTTP ${res.status}`,
        lastPingedAt: new Date().toISOString(),
      };
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn(`ping failed: ${url} — ${msg}`);
      const lower = msg.toLowerCase();
      const isTimeout =
        lower.includes('timeout') ||
        lower.includes('timed out') ||
        lower.includes('aborted');
      return {
        status: 'down',
        latencyMs: Date.now() - start,
        reason: isTimeout ? 'timeout' : msg,
        lastPingedAt: new Date().toISOString(),
      };
    }
  }
}
