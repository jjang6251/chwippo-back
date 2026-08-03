import { DiscordNotifier } from '../common/discord-notifier';
import { MODEL_REGISTRY } from './model-registry';
import { ModelPricingExpiryCron } from './model-pricing-expiry.cron';

/**
 * G-1 — 단가 만료 사전 알림.
 *
 * ⚠️ **2026-08-03 부터 실제 대상이 생겼다** — Sonnet 5 인트로 단가가 8/31 만료다.
 * 그전까지는 등록 모델에 `validUntil` 이 하나도 없어 "운영에선 안 울린다" 가 전제였고,
 * 그 전제로 쓰인 테스트들이 실제 모델이 등록되자 **다른 이유로 깨졌다**
 * (프로모 모델 1건을 기대했는데 Sonnet 5 까지 2건이 울림).
 *
 * 그래서 cron **로직** 테스트는 실제 레지스트리와 격리한다 — 모델이 추가·삭제될 때마다
 * 로직 테스트가 깨지면 안 된다. 실제 등록 내용은 아래 별도 describe 에서 본다.
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

  /** 로직 테스트 동안 치워둔 실제 만료 모델 (afterEach 에서 되돌린다) */
  let stashed: Record<string, (typeof MODEL_REGISTRY)[string]> = {};

  beforeEach(() => {
    notify = jest.fn().mockResolvedValue('sent');
    cron = new ModelPricingExpiryCron({
      notify,
    } as unknown as DiscordNotifier);
    // 실제 레지스트리에서 유효기간 있는 모델을 잠시 제거 — 로직만 검증하기 위해
    stashed = {};
    for (const [id, spec] of Object.entries(MODEL_REGISTRY)) {
      if (spec.pricing.validUntil) {
        stashed[id] = spec;
        delete MODEL_REGISTRY[id];
      }
    }
  });

  afterEach(() => {
    delete MODEL_REGISTRY[PROMO];
    Object.assign(MODEL_REGISTRY, stashed);
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
    it('유효기간 없는 모델은 알리지 않는다', async () => {
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

/**
 * 위 describe 는 cron **로직**을 보느라 실제 만료 모델을 치워둔다.
 * 그래서 "진짜로 선언이 돼 있는가" 는 여기서 따로 본다 — 격리와 실물 확인은 다른 질문이다.
 */
describe('실제 등록된 만료 단가', () => {
  it('Sonnet 5 인트로는 8/31 만료 + next 가 함께 선언돼 있다', () => {
    const p = MODEL_REGISTRY['claude-sonnet-5'].pricing;
    expect(p.validUntil).toBe('2026-08-31');
    // next 가 없으면 cron 이 "미완 선언" 으로 보고 조용히 넘어간다 — 알림이 안 온다
    expect(p.next).toEqual({ input: 3.0, output: 15.0 });
    expect(p.input).toBe(2.0);
    expect(p.output).toBe(10.0);
  });

  /**
   * 🔴 만료를 선언해놓고 `next` 를 빠뜨리면 **알림도 안 오고 단가도 안 바뀐다** —
   * 가장 조용한 실패다. 앞으로 추가되는 모델에도 강제한다.
   */
  it('validUntil 을 선언한 모델은 반드시 next 도 갖는다', () => {
    for (const [id, spec] of Object.entries(MODEL_REGISTRY)) {
      if (spec.pricing.validUntil) {
        expect(`${id}:${spec.pricing.next ? 'ok' : 'next 누락'}`).toBe(
          `${id}:ok`,
        );
      }
    }
  });
});
