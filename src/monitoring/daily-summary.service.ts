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
}

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
    };
  }
}
