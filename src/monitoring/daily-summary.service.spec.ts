import { DataSource } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { DailySummaryService } from './daily-summary.service';
import { DiscordNotifier } from '../common/discord-notifier';

describe('DailySummaryService', () => {
  let service: DailySummaryService;
  let dataSource: jest.Mocked<DataSource>;
  let discord: jest.Mocked<DiscordNotifier>;

  function setupQuery(counts: {
    total?: number;
    users?: number;
    deleted?: number;
    activity?: number;
    reports?: number;
    cost?: number;
    noCard?: number;
    briefing?: number;
    urgent?: number;
  }) {
    dataSource.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM notification_logs')) {
        return Promise.resolve([
          { type: 'briefing', n: String(counts.briefing ?? 0) },
          { type: 'deadline_urgent', n: String(counts.urgent ?? 0) },
        ]);
      }
      if (sql.includes('FROM users u')) {
        return Promise.resolve([{ n: String(counts.noCard ?? 0) }]);
      }
      if (sql.includes('FROM user_deletion_logs')) {
        return Promise.resolve([{ n: String(counts.deleted ?? 0) }]);
      }
      if (sql.includes('FROM users WHERE')) {
        return Promise.resolve([{ n: String(counts.users ?? 0) }]);
      }
      if (sql.includes('FROM users')) {
        return Promise.resolve([{ n: String(counts.total ?? 0) }]);
      }
      if (sql.includes('FROM activity_logs')) {
        return Promise.resolve([{ n: String(counts.activity ?? 0) }]);
      }
      if (sql.includes('FROM ai_content_reports')) {
        return Promise.resolve([{ n: String(counts.reports ?? 0) }]);
      }
      if (sql.includes('FROM llm_call_logs')) {
        return Promise.resolve([{ n: String(counts.cost ?? 0) }]);
      }
      return Promise.resolve([{ n: '0' }]);
    });
  }

  beforeEach(() => {
    dataSource = mock<DataSource>();
    discord = mock<DiscordNotifier>();
    discord.notify.mockResolvedValue('sent');
    service = new DailySummaryService(dataSource, discord);
  });

  it('집계 후 ops 채널로 발송 (총회원·신규·탈퇴 포함)', async () => {
    setupQuery({
      total: 100,
      users: 5,
      deleted: 2,
      activity: 12,
      reports: 1,
      cost: 0.42,
      noCard: 2,
      briefing: 3,
      urgent: 1,
    });

    const summary = await service.sendDailySummary();

    expect(summary.totalUsers).toBe(100);
    expect(summary.newUsers).toBe(5);
    expect(summary.deletedUsers).toBe(2);
    expect(summary.newUsersNoCard).toBe(2);
    const embed = JSON.stringify(discord.notify.mock.calls[0][0]);
    expect(embed).toContain('총 회원 100명');
    expect(embed).toContain('신규 +5');
    expect(embed).toContain('탈퇴 −2');
    expect(embed).toContain('순증 +3'); // 5 - 2
    expect(discord.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('일일 운영 요약'),
      }),
      'ops',
    );
  });

  it('빈 24h → 전부 0 · 정상 발송', async () => {
    setupQuery({ total: 0 });
    const summary = await service.sendDailySummary();
    expect(summary.newUsers).toBe(0);
    expect(summary.aiCostUsd).toBe(0);
    const embed = JSON.stringify(discord.notify.mock.calls[0][0]);
    expect(embed).toContain('총 회원 0명');
    expect(embed).toContain('순증 0');
  });

  it('가입자 중 카드 0개 필드 포함', async () => {
    setupQuery({ users: 3, noCard: 3 });
    await service.sendDailySummary();
    const embed = JSON.stringify(discord.notify.mock.calls[0][0]);
    expect(embed).toContain('카드 0개');
    expect(embed).toContain('3명');
  });
});
