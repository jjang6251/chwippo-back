import { ConfigService } from '@nestjs/config';
import { mock } from 'jest-mock-extended';
import { DiscordNotifier } from './discord-notifier';

describe('DiscordNotifier — 채널 분리', () => {
  let notifier: DiscordNotifier;
  let config: jest.Mocked<ConfigService>;
  let fetchMock: jest.Mock;

  const URLS: Record<string, string> = {
    DISCORD_WEBHOOK_CRITICAL: 'https://discord/critical',
    DISCORD_WEBHOOK_INQUIRIES: 'https://discord/inquiries',
    DISCORD_WEBHOOK_GROWTH: 'https://discord/growth',
    DISCORD_WEBHOOK_OPS: 'https://discord/ops',
    ADMIN_ALERT_WEBHOOK_URL: 'https://discord/legacy',
  };

  beforeEach(() => {
    config = mock<ConfigService>();
    config.get.mockImplementation((key: string) => URLS[key]);
    notifier = new DiscordNotifier(config);
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    global.fetch = fetchMock;
  });

  it('channel 지정 → 해당 채널 웹훅 사용', async () => {
    const r = await notifier.notify('hi', 'critical');
    expect(r).toBe('sent');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord/critical',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('channel 웹훅 미설정 → legacy fallback', async () => {
    config.get.mockImplementation((key: string) =>
      key === 'ADMIN_ALERT_WEBHOOK_URL' ? URLS[key] : undefined,
    );
    const r = await notifier.notify('hi', 'growth');
    expect(r).toBe('sent');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord/legacy',
      expect.anything(),
    );
  });

  it('channel 미지정 → legacy 사용', async () => {
    await notifier.notify('hi');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord/legacy',
      expect.anything(),
    );
  });

  it('웹훅 전부 미설정 → skipped_no_webhook (fetch 안 함)', async () => {
    config.get.mockReturnValue(undefined);
    const r = await notifier.notify('hi', 'ops');
    expect(r).toBe('skipped_no_webhook');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('webhook 5xx 응답 → failed', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const r = await notifier.notify('hi', 'critical');
    expect(r).toBe('failed');
  });

  it('fetch throw → failed (caller 로 전파 X)', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    const r = await notifier.notify('hi', 'critical');
    expect(r).toBe('failed');
  });

  it('string → content body (+ 채널 username)', async () => {
    await notifier.notify('hello', 'ops');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).toBe('hello');
    expect(body.username).toBe('아침뽀');
  });

  it('embed → embeds body + 채널 기본색 주입', async () => {
    await notifier.notify({ title: '가입', fields: [] }, 'growth');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.embeds[0].title).toBe('가입');
    expect(body.embeds[0].color).toBe(0x57f287); // growth 기본색
  });

  it('embed.color 지정 시 채널 기본색 대신 사용', async () => {
    await notifier.notify({ title: 't', color: 0xf1c40f }, 'growth');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.embeds[0].color).toBe(0xf1c40f);
  });

  it('inquiries 채널 웹훅 사용', async () => {
    await notifier.notify({ title: '문의' }, 'inquiries');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord/inquiries',
      expect.anything(),
    );
  });

  it('채널별 봇 이름(username) 주입', async () => {
    await notifier.notify({ title: '가입' }, 'growth');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.username).toBe('새싹뽀');
  });

  it('legacy fallback(channel 없음) → username 없음', async () => {
    await notifier.notify('hi');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.username).toBeUndefined();
  });
});
