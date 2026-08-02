import { DiscordNotifier } from '../common/discord-notifier';
import { MODEL_REGISTRY } from './model-registry';
import { ModelPricingExpiryCron } from './model-pricing-expiry.cron';

/**
 * G-1 — 단가 만료 사전 알림.
 *
 * 🔴 **현재 등록된 4개 모델에는 `validUntil` 이 없다.** 즉 운영에서는 아직 한 번도
 * 울리지 않는다 — 이 spec 이 유일한 검증 수단이다. 나중에 프로모션 단가 모델을
 * 넣는 사람이 "알림이 되긴 하나" 를 여기서 확인할 수 있어야 한다.
 */
describe('ModelPricingExpiryCron', () => {
  const PROMO = 'test-only-promo-model';
  let notify: jest.Mock;
  let cron: ModelPricingExpiryCron;

  /** 오늘을 고정하기 위해 todayKst 가 읽는 시계를 고정 */
  const freeze = (kstDate: string) => {
    jest.useFakeTimers();
    // KST 정오로 고정 — 자정 경계에서 날짜가 흔들리지 않게
    jest.setSystemTime(new Date(`${kstDate}T03:00:00Z`));
  };

  const registerPromo = (validUntil: string) => {
    MODEL_REGISTRY[PROMO] = {
      ...MODEL_REGISTRY['claude-sonnet-4-6'],
      label: '프로모 모델',
      pricing: {
        ...MODEL_REGISTRY['claude-sonnet-4-6'].pricing,
        input: 2,
        output: 10,
        validUntil,
        next: { input: 3, output: 15 },
      },
    };
  };

  beforeEach(() => {
    notify = jest.fn().mockResolvedValue('sent');
    cron = new ModelPricingExpiryCron({
      notify,
    } as unknown as DiscordNotifier);
  });

  afterEach(() => {
    delete MODEL_REGISTRY[PROMO];
    jest.useRealTimers();
  });

  describe('알림 발동 구간', () => {
    it('만료 7일 전 — 알린다 (경계)', async () => {
      registerPromo('2026-08-31');
      freeze('2026-08-24');

      await cron.runDaily();

      expect(notify).toHaveBeenCalledTimes(1);
      const [embed, channel] = notify.mock.calls[0];
      expect(embed.title).toContain('만료 예정');
      expect(embed.description).toContain('7일 뒤');
      expect(channel).toBe('ops');
    });

    it('만료 8일 전 — 아직 안 알린다 (경계)', async () => {
      registerPromo('2026-08-31');
      freeze('2026-08-23');

      await cron.runDaily();
      expect(notify).not.toHaveBeenCalled();
    });

    it('만료 당일 — 아직 기존 단가라 예고 문구', async () => {
      registerPromo('2026-08-31');
      freeze('2026-08-31');

      await cron.runDaily();
      expect(notify.mock.calls[0][0].title).toContain('만료 예정');
    });

    /** 🔴 여기가 핵심 — "오늘부터 비싸졌다" 를 사람이 알아야 가격 정책을 다시 본다 */
    it('만료 다음 날 — 인상 사실을 사후 통지', async () => {
      registerPromo('2026-08-31');
      freeze('2026-09-01');

      await cron.runDaily();

      const embed = notify.mock.calls[0][0];
      expect(embed.title).toContain('오늘부터 인상');
      expect(embed.description).toContain('$3/$15');
    });

    it('만료 이틀 뒤부터는 안 알린다 (반복 알림 방지)', async () => {
      registerPromo('2026-08-31');
      freeze('2026-09-02');

      await cron.runDaily();
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe('대상이 아닌 경우', () => {
    it('유효기간 없는 모델은 알리지 않는다 (= 현재 등록된 4개 전부)', async () => {
      freeze('2026-08-24');
      await cron.runDaily();
      expect(notify).not.toHaveBeenCalled();
    });

    it('validUntil 만 있고 next 가 없으면 알리지 않는다 (미완 선언)', async () => {
      MODEL_REGISTRY[PROMO] = {
        ...MODEL_REGISTRY['claude-sonnet-4-6'],
        pricing: {
          ...MODEL_REGISTRY['claude-sonnet-4-6'].pricing,
          validUntil: '2026-08-31',
        },
      };
      freeze('2026-08-30');

      await cron.runDaily();
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe('실패 처리', () => {
    /** 알림이 안 갔다는 사실은 남아야 한다 — 조용히 넘어가면 만료를 놓친다 */
    it('Discord 실패 시 warn 로그를 남긴다 (서버는 죽지 않는다)', async () => {
      registerPromo('2026-08-31');
      freeze('2026-08-30');
      notify.mockResolvedValue('failed');
      const spy = jest
        .spyOn(
          (cron as unknown as { logger: { warn: (m: string) => void } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);

      await expect(cron.runDaily()).resolves.toBeUndefined();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain(PROMO);
    });

    it('webhook 미설정(skipped)은 실패가 아니다', async () => {
      registerPromo('2026-08-31');
      freeze('2026-08-30');
      notify.mockResolvedValue('skipped_no_webhook');
      const spy = jest
        .spyOn(
          (cron as unknown as { logger: { warn: (m: string) => void } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);

      await cron.runDaily();
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
