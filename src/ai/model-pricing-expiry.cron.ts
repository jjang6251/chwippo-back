import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DISCORD_COLORS, DiscordNotifier } from '../common/discord-notifier';
import { todayKst } from '../common/datetime';
import { MODEL_REGISTRY } from './model-registry';

/** 만료 며칠 전부터 알릴 것인가 — 대응(모델 교체·가격 재검토)에 필요한 최소 시간 */
const WARN_DAYS_BEFORE = 7;

/**
 * G-1 (2026-08-02) — 모델 단가 **유효기간 만료 사전 알림**.
 *
 * **왜 필요한가** — 프로모션·인트로 단가는 조용히 끝난다. 만료 다음 날부터 원가가
 * 오르는데 코인 차감식은 그대로라 **마진이 소리 없이 깎인다.** 코드는
 * `effectivePricing` 이 자동 전환해 주지만, **"오늘부터 비싸졌다" 는 사실을 사람이
 * 알아야** 가격·모델 정책을 다시 볼 수 있다.
 *
 * 이번 작업 전체가 "박아두고 아무도 안 보는 상수" 를 없애는 것이었고, 단가 만료도
 * 같은 유형이다 — 달력에 적어두는 대신 시스템이 알리게 한다.
 *
 * **실패해도 조용히 넘어가지 않는다** — Discord 실패는 warn 로그로 남긴다.
 * (알림 실패로 서버가 죽으면 안 되지만, 알림이 안 갔다는 사실은 남아야 한다)
 */
@Injectable()
export class ModelPricingExpiryCron {
  private readonly logger = new Logger(ModelPricingExpiryCron.name);

  constructor(private readonly discord: DiscordNotifier) {}

  /** 매일 09:10 KST — 업무 시작 시각에 맞춰 (자정 알림은 아무도 안 본다) */
  @Cron('10 9 * * *', { timeZone: 'Asia/Seoul' })
  async runDaily(): Promise<void> {
    const today = todayKst();
    const soon = this.findExpiring(today);

    if (soon.length === 0) return;

    for (const item of soon) {
      const line = item.expired
        ? `**${item.label}** 단가가 ${item.validUntil} 로 만료돼 오늘부터 새 단가($${item.nextInput}/$${item.nextOutput} per 1M)가 적용됩니다.`
        : `**${item.label}** 단가가 **${item.daysLeft}일 뒤**(${item.validUntil}) 만료됩니다 → $${item.input}/$${item.output} → $${item.nextInput}/$${item.nextOutput} per 1M.`;

      const result = await this.discord.notify(
        {
          title: item.expired
            ? '💸 모델 단가 만료 — 오늘부터 인상'
            : '⏳ 모델 단가 만료 예정',
          description:
            `${line}\n\n` +
            `코인 차감은 \`MODEL_REGISTRY\` 파생이라 자동으로 따라가지만, ` +
            `**마진·가격 정책을 다시 볼 시점**입니다.`,
          color: item.expired ? DISCORD_COLORS.red : DISCORD_COLORS.yellow,
        },
        'ops',
      );

      if (result === 'failed') {
        this.logger.warn(
          `단가 만료 알림 전송 실패 (model=${item.id}, validUntil=${item.validUntil})`,
        );
      }
    }
  }

  /**
   * 만료 임박·당일 경과 모델 추출.
   * `todayKst` 기준 문자열 비교 — KST 고정 앱이라 `YYYY-MM-DD` 비교로 충분하다.
   */
  private findExpiring(today: string) {
    const out: Array<{
      id: string;
      label: string;
      validUntil: string;
      daysLeft: number;
      expired: boolean;
      input: number;
      output: number;
      nextInput: number;
      nextOutput: number;
    }> = [];

    for (const [id, spec] of Object.entries(MODEL_REGISTRY)) {
      const p = spec.pricing;
      if (!p.validUntil || !p.next) continue;

      const daysLeft = this.daysBetween(today, p.validUntil);
      // 만료 당일(0) 까지 예고 · 만료 바로 다음 날(-1) 1회 사후 통지
      if (daysLeft > WARN_DAYS_BEFORE || daysLeft < -1) continue;

      out.push({
        id,
        label: spec.label,
        validUntil: p.validUntil,
        daysLeft,
        expired: daysLeft < 0,
        input: p.input,
        output: p.output,
        nextInput: p.next.input,
        nextOutput: p.next.output,
      });
    }
    return out;
  }

  /** `to - from` (일). KST 날짜 문자열끼리라 UTC 파싱으로 안전하게 계산한다 */
  private daysBetween(from: string, to: string): number {
    const a = Date.parse(`${from}T00:00:00Z`);
    const b = Date.parse(`${to}T00:00:00Z`);
    return Math.round((b - a) / 86_400_000);
  }
}
