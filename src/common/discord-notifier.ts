import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type DiscordNotifyResult = 'sent' | 'failed' | 'skipped_no_webhook';

export type DiscordChannel = 'critical' | 'inquiries' | 'growth' | 'ops';

/** Discord embed (색 막대 + 제목 + 필드) — 가독성 */
export interface DiscordEmbed {
  title: string;
  description?: string;
  /** decimal color · 미지정 시 채널 기본색 */
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
}

const CHANNEL_ENV: Record<DiscordChannel, string> = {
  critical: 'DISCORD_WEBHOOK_CRITICAL',
  inquiries: 'DISCORD_WEBHOOK_INQUIRIES',
  growth: 'DISCORD_WEBHOOK_GROWTH',
  ops: 'DISCORD_WEBHOOK_OPS',
};

/** 채널 기본 색 (embed.color 미지정 시) */
const CHANNEL_COLOR: Record<DiscordChannel, number> = {
  critical: 0xed4245, // 빨강
  inquiries: 0xfee75c, // 노랑
  growth: 0x57f287, // 초록
  ops: 0x5865f2, // 파랑
};

/** 채널별 봇 표시 이름 (webhook username · 브랜드 라임 `~뽀`) */
const CHANNEL_USERNAME: Record<DiscordChannel, string> = {
  critical: '삐뽀',
  inquiries: '문의뽀',
  growth: '새싹뽀',
  ops: '아침뽀',
};

/** 알람 세부 색 (embed.color 로 caller 가 사용) */
export const DISCORD_COLORS = {
  red: 0xed4245,
  yellow: 0xfee75c,
  green: 0x57f287,
  blue: 0x5865f2,
  gray: 0x99aab5,
  gold: 0xf1c40f,
} as const;

/**
 * Discord webhook 유틸 — 채널 4개(critical/inquiries/growth/ops) + embed + fallback.
 *
 * - channel 지정 시 `DISCORD_WEBHOOK_{CHANNEL}` 우선 · 없으면 `ADMIN_ALERT_WEBHOOK_URL` fallback
 * - message 가 string → `{ content }` · DiscordEmbed → `{ embeds: [...] }` (색 막대 가독성)
 * - 셋 다 미설정 시 skip (무중단). best-effort — 실패해도 caller 영향 X.
 *
 * 환경 분리는 env 값으로 (테스트 서버 웹훅 = 로컬 .env / 운영 = 배포 env).
 */
@Injectable()
export class DiscordNotifier {
  private readonly logger = new Logger(DiscordNotifier.name);

  constructor(private readonly config: ConfigService) {}

  async notify(
    message: string | DiscordEmbed,
    channel?: DiscordChannel,
  ): Promise<DiscordNotifyResult> {
    const webhookUrl = this.resolveWebhook(channel);
    if (!webhookUrl) return 'skipped_no_webhook';

    // 채널별 봇 이름 (username) · legacy fallback(channel 없음)이면 기본 웹훅 이름 사용
    const username = channel ? CHANNEL_USERNAME[channel] : undefined;
    const payload =
      typeof message === 'string'
        ? { content: message }
        : {
            embeds: [
              {
                ...message,
                color:
                  message.color ??
                  (channel ? CHANNEL_COLOR[channel] : undefined),
                // Discord 가 뷰어 로케일로 상대시간 렌더 (가독성)
                timestamp: new Date().toISOString(),
              },
            ],
          };
    const body = username ? { ...payload, username } : payload;

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

  private resolveWebhook(channel?: DiscordChannel): string | undefined {
    if (channel) {
      const channelUrl = this.config.get<string>(CHANNEL_ENV[channel]);
      if (channelUrl) return channelUrl;
    }
    return this.config.get<string>('ADMIN_ALERT_WEBHOOK_URL');
  }
}
