import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type DiscordNotifyResult = 'sent' | 'failed' | 'skipped_no_webhook';

/**
 * F6 PR 2 Phase 5.4 — Discord webhook 공용 유틸.
 *
 * abuser-ban.service 와 threshold-check.service 둘 다 사용.
 * `ADMIN_ALERT_WEBHOOK_URL` 미설정 시 skip (dev 환경 OK).
 * best-effort — 실패해도 caller 본 액션 영향 X.
 */
@Injectable()
export class DiscordNotifier {
  private readonly logger = new Logger(DiscordNotifier.name);

  constructor(private readonly config: ConfigService) {}

  async notify(content: string): Promise<DiscordNotifyResult> {
    const webhookUrl = this.config.get<string>('ADMIN_ALERT_WEBHOOK_URL');
    if (!webhookUrl) return 'skipped_no_webhook';

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        this.logger.warn(`Discord webhook returned ${res.status}`);
        return 'failed';
      }
      return 'sent';
    } catch (err) {
      this.logger.warn(`Discord webhook failed: ${(err as Error).message}`);
      return 'failed';
    }
  }
}
