import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscordNotifier, DISCORD_COLORS } from '../common/discord-notifier';

const WINDOW_MS = 10 * 60 * 1000; // 10분
const DEDUP_MS = 60 * 60 * 1000; // 1시간

/**
 * 5xx 스파이크 감시 — in-memory sliding window.
 *
 * 10분 window 에 5xx 가 threshold(env HTTP_5XX_ALERT_THRESHOLD · default 20) 초과 시
 * critical 채널 즉시 alert. 1시간 dedup (재발도 표기). restart 시 초기화 OK (best-effort).
 *
 * AllExceptionsFilter 에서 status>=500 시 record() 호출 (DI 주입은 main.ts app.get).
 */
@Injectable()
export class Http5xxMonitorService {
  private readonly logger = new Logger(Http5xxMonitorService.name);
  private readonly threshold: number;
  private timestamps: number[] = [];
  private lastAlertAt = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly discord: DiscordNotifier,
  ) {
    this.threshold = this.config.get<number>('HTTP_5XX_ALERT_THRESHOLD') ?? 20;
  }

  /** 5xx 1건 기록 · window 초과 시 alert. now 인자는 테스트용 */
  record(path: string, now: number = Date.now()): void {
    this.timestamps.push(now);
    // window 밖 제거
    const cutoff = now - WINDOW_MS;
    this.timestamps = this.timestamps.filter((t) => t >= cutoff);

    if (this.timestamps.length < this.threshold) return;
    // dedup — 1시간 내 재알림 억제
    if (now - this.lastAlertAt < DEDUP_MS) return;

    this.lastAlertAt = now;
    const count = this.timestamps.length;
    void this.discord
      .notify(
        {
          title: '🚨 5xx 스파이크',
          description: 'Railway 로그 확인 필요',
          color: DISCORD_COLORS.red,
          fields: [
            {
              name: '발생',
              value: `${count}건 / 10분 (threshold ${this.threshold})`,
            },
            { name: '최근 path', value: path },
          ],
        },
        'critical',
      )
      .catch((err) =>
        this.logger.warn(`5xx alert 발송 실패: ${(err as Error).message}`),
      );
  }
}
