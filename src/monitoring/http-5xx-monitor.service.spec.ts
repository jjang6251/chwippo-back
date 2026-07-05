import { ConfigService } from '@nestjs/config';
import { mock } from 'jest-mock-extended';
import { Http5xxMonitorService } from './http-5xx-monitor.service';
import { DiscordNotifier } from '../common/discord-notifier';

describe('Http5xxMonitorService', () => {
  let monitor: Http5xxMonitorService;
  let discord: jest.Mocked<DiscordNotifier>;
  const T0 = 1_000_000_000_000;

  function build(threshold = 3): Http5xxMonitorService {
    const config = mock<ConfigService>();
    config.get.mockReturnValue(threshold);
    discord = mock<DiscordNotifier>();
    discord.notify.mockResolvedValue('sent');
    return new Http5xxMonitorService(config, discord);
  }

  beforeEach(() => {
    monitor = build(3);
  });

  it('threshold 미만 → 알림 없음', () => {
    monitor.record('/a', T0);
    monitor.record('/a', T0 + 1000);
    expect(discord.notify).not.toHaveBeenCalled();
  });

  it('threshold 도달 → critical 알림', () => {
    monitor.record('/a', T0);
    monitor.record('/a', T0 + 1000);
    monitor.record('/a', T0 + 2000);
    expect(discord.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('5xx 스파이크'),
      }),
      'critical',
    );
  });

  it('1시간 dedup — 연속 초과해도 1회만', () => {
    for (let i = 0; i < 5; i++) monitor.record('/a', T0 + i * 1000);
    expect(discord.notify).toHaveBeenCalledTimes(1);
  });

  it('10분 window slide — 오래된 5xx 는 카운트에서 빠짐', () => {
    monitor.record('/a', T0); // window 밖으로 밀려남
    monitor.record('/a', T0 + 11 * 60 * 1000); // 11분 후 (T0 제거)
    monitor.record('/a', T0 + 11 * 60 * 1000 + 1000);
    // 유효 카운트 2 < threshold 3 → 알림 없음
    expect(discord.notify).not.toHaveBeenCalled();
  });

  it('dedup 1시간 경과 후 재발 → 재알림', () => {
    for (let i = 0; i < 3; i++) monitor.record('/a', T0 + i * 1000);
    expect(discord.notify).toHaveBeenCalledTimes(1);
    // 1시간 뒤 다시 threshold (window 는 10분이라 새 timestamps)
    const later = T0 + 61 * 60 * 1000;
    for (let i = 0; i < 3; i++) monitor.record('/a', later + i * 1000);
    expect(discord.notify).toHaveBeenCalledTimes(2);
  });
});
