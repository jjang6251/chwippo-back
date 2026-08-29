import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DiscordNotifier, DISCORD_COLORS } from '../common/discord-notifier';

interface DailySummary {
  totalUsers: number;
  newUsers: number;
  deletedUsers: number;
  activityLogs: number;
  reports: number;
  aiCostUsd: number;
  briefingsSent: number;
  urgentSent: number;
  newUsersNoCard: number;
  /** 임계를 넘긴 것만 담긴다 — 평소엔 빈 배열이라 요약에 줄이 안 붙는다 */
  aiAnomalies: AiAnomaly[];
}

/**
 * AI 이상 징후 — **한도를 사실상 없앤 기능이 생겼으니 감시가 그 자리를 대신한다.**
 *
 * 공고 → 카드(대장 21)는 코인 0 · admin 일 200(사람은 못 닿는 값)으로 열었다. 그 대가로
 * 「누가 스크립트로 돌리고 있나」와 「어떤 기능이 갑자기 비싸졌나」를 매일 한 번은 봐야 한다.
 * 실시간 감시를 새로 만들지 않고 **이미 매일 오는 요약**에 얹는 이유 —
 * 09:30 요약은 안 오면 그 자체가 장애 신호라(heartbeat) 전달이 보장된 유일한 채널이다.
 */
interface AiAnomaly {
  kind: 'heavy_user' | 'costly_feature';
  feature: string;
  /** heavy_user 면 그 사용자 id, costly_feature 면 null */
  userId: string | null;
  /** heavy_user 면 호출 수, costly_feature 면 원 단위 비용 */
  value: number;
}

/** 1인 하루 호출 수 임계 — 사람이 공고 50개를 붙여넣는 하루는 없다 */
const HEAVY_USER_CALLS = 50;
/** 기능 하루 비용 임계 (원) */
const COSTLY_FEATURE_KRW = 5000;
/**
 * 달러 → 원 고정 환산. **임계 판정용이라 정밀할 필요가 없다** — 환율이 10% 움직여도
 * 「5,000원 넘었나」의 답은 거의 안 바뀐다. 실시간 환율을 끌어오면 외부 의존이 하나 늘고,
 * 그게 죽으면 알림이 조용히 멈춘다 (감시가 감시 대상보다 약해진다).
 */
const KRW_PER_USD = 1400;

/**
 * 일일 운영 요약 — 매일 09:30 KST, ops 채널.
 *
 * rolling 24h 집계 (닉네임 X · 카운트만). Heartbeat 겸용:
 * 09:30 에 요약이 안 오면 = 백엔드/cron 이상 신호 (별도 dead-man 도구 불필요).
 *
 * 탈퇴 = user_deletion_logs 24h 집계 (users hard delete 대비 별도 로그).
 * 순증 = 신규 - 탈퇴.
 */
@Injectable()
export class DailySummaryService {
  private readonly logger = new Logger(DailySummaryService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly discord: DiscordNotifier,
  ) {}

  async sendDailySummary(): Promise<DailySummary> {
    const summary = await this.collect();

    const net = summary.newUsers - summary.deletedUsers;
    const netStr = net > 0 ? `+${net}` : `${net}`;

    await this.discord.notify(
      {
        title: '📊 일일 운영 요약',
        description:
          `**총 회원 ${summary.totalUsers}명**\n` +
          `어제 신규 +${summary.newUsers} · 탈퇴 −${summary.deletedUsers} · 순증 ${netStr}`,
        color: DISCORD_COLORS.blue,
        fields: [
          {
            name: '📝 활동 로그',
            value: `${summary.activityLogs}건`,
            inline: true,
          },
          {
            name: '🔔 알림 발송',
            value: `브리핑 ${summary.briefingsSent} · 긴급 ${summary.urgentSent}`,
            inline: true,
          },
          {
            name: '💰 AI 비용',
            value: `$${summary.aiCostUsd.toFixed(2)}`,
            inline: true,
          },
          { name: '📨 신고', value: `${summary.reports}건`, inline: true },
          {
            name: '⚠️ 신규 중 카드 0개',
            value: `${summary.newUsersNoCard}명`,
            inline: true,
          },
          // 임계를 넘겼을 때만 줄이 붙는다 — 매일 「이상 없음」을 적으면 있을 때도 안 읽힌다
          ...(summary.aiAnomalies.length > 0
            ? [
                {
                  name: '🚨 AI 이상 징후',
                  value: summary.aiAnomalies
                    .map((a) =>
                      a.kind === 'heavy_user'
                        ? `${a.feature} · ${a.userId} — ${a.value}회`
                        : `${a.feature} — 약 ${a.value.toLocaleString('ko-KR')}원`,
                    )
                    .join('\n')
                    .slice(0, 1000),
                  inline: false,
                },
              ]
            : []),
        ],
      },
      'ops',
    );
    this.logger.log(
      `[DailySummary] 발송 (총 ${summary.totalUsers} · 신규 ${summary.newUsers} · 탈퇴 ${summary.deletedUsers})`,
    );
    return summary;
  }

  private async collect(): Promise<DailySummary> {
    const count = async (sql: string): Promise<number> => {
      const rows = await this.dataSource.query<{ n: string }[]>(sql);
      return Number(rows[0]?.n ?? 0);
    };

    const [
      totalUsers,
      newUsers,
      deletedUsers,
      activityLogs,
      reports,
      aiCostUsd,
      newUsersNoCard,
    ] = await Promise.all([
      count(`SELECT COUNT(*) AS n FROM users`),
      count(
        `SELECT COUNT(*) AS n FROM users WHERE created_at >= NOW() - INTERVAL '24 hours'`,
      ),
      count(
        `SELECT COUNT(*) AS n FROM user_deletion_logs WHERE created_at >= NOW() - INTERVAL '24 hours'`,
      ),
      count(
        `SELECT COUNT(*) AS n FROM activity_logs WHERE created_at >= NOW() - INTERVAL '24 hours'`,
      ),
      count(
        `SELECT COUNT(*) AS n FROM ai_content_reports WHERE created_at >= NOW() - INTERVAL '24 hours'`,
      ),
      count(
        `SELECT COALESCE(SUM(cost_usd), 0) AS n FROM llm_call_logs WHERE created_at >= NOW() - INTERVAL '24 hours'`,
      ),
      // 지난 24h 가입자 중 실 카드(is_sample=false) 0개
      count(
        `SELECT COUNT(*) AS n FROM users u
             WHERE u.created_at >= NOW() - INTERVAL '24 hours'
               AND NOT EXISTS (
                 SELECT 1 FROM applications a
                  WHERE a.user_id = u.id AND a.is_sample = false AND a.deleted_at IS NULL
               )`,
      ),
    ]);

    // 알림 발송 (notification_logs type 별)
    const logRows = await this.dataSource.query<{ type: string; n: string }[]>(
      `SELECT type, COUNT(*) AS n FROM notification_logs
        WHERE sent_at >= NOW() - INTERVAL '24 hours' GROUP BY type`,
    );
    const byType = new Map<string, number>(
      logRows.map((r) => [r.type, Number(r.n)]),
    );

    return {
      totalUsers,
      newUsers,
      deletedUsers,
      activityLogs,
      reports,
      aiCostUsd,
      briefingsSent: byType.get('briefing') ?? 0,
      urgentSent: byType.get('deadline_urgent') ?? 0,
      newUsersNoCard,
      aiAnomalies: await this.collectAiAnomalies(),
    };
  }

  /**
   * 지난 24h AI 이상 징후 — 임계를 넘긴 것만.
   *
   * 🔴 **전 기능을 본다.** 공고 카드 때문에 만든 감시지만 feature 를 고정하면 다음에
   * 한도를 여는 기능이 또 같은 구멍을 판다. `GROUP BY` 하나로 전부 덮인다.
   */
  private async collectAiAnomalies(): Promise<AiAnomaly[]> {
    const heavy = await this.dataSource.query<
      { feature: string; user_id: string; n: string }[]
    >(
      `SELECT feature, user_id, COUNT(*)::int AS n
         FROM llm_call_logs
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY feature, user_id
       HAVING COUNT(*) >= $1
        ORDER BY n DESC
        LIMIT 10`,
      [HEAVY_USER_CALLS],
    );

    const costly = await this.dataSource.query<
      { feature: string; cost: string }[]
    >(
      `SELECT feature, COALESCE(SUM(cost_usd), 0) AS cost
         FROM llm_call_logs
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY feature
       HAVING COALESCE(SUM(cost_usd), 0) * $1 >= $2
        ORDER BY cost DESC
        LIMIT 10`,
      [KRW_PER_USD, COSTLY_FEATURE_KRW],
    );

    return [
      ...heavy.map(
        (r): AiAnomaly => ({
          kind: 'heavy_user',
          feature: r.feature,
          userId: r.user_id,
          value: Number(r.n),
        }),
      ),
      ...costly.map(
        (r): AiAnomaly => ({
          kind: 'costly_feature',
          feature: r.feature,
          userId: null,
          value: Math.round(Number(r.cost) * KRW_PER_USD),
        }),
      ),
    ];
  }
}
