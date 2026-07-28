/**
 * instrument.ts PII 스크러빙 spec.
 *
 * 개인정보처리방침(2026-08-04 시행) §1 이 "회원이 작성한 내용은 포함되지 않는다"고
 * 공표하므로, 아래 단언이 깨지면 **방침 위반**이다. 편의 기능 테스트가 아니다.
 *
 * 시나리오:
 *  1. request.data(자소서 본문) 제거
 *  2. URL 쿼리스트링 절단 (OAuth code·state)
 *  3. headers(Authorization)·cookies(refresh token) 제거
 *  4. user 는 id 만 (이메일·닉네임 제거)
 *  5. 예외 message 길이 cap (LLM 프롬프트 유출 차단)
 *  6. console breadcrumb 제거
 *  7. breadcrumb URL 쿼리스트링 절단
 *  8. 빈 이벤트에도 안전
 *  9. SENTRY_DSN 미설정 시 Sentry.init 미호출
 */
import type { ErrorEvent } from '@sentry/nestjs';
import * as Sentry from '@sentry/nestjs';
import { scrubEvent, initSentry } from './instrument';

jest.mock('@sentry/nestjs', () => ({ init: jest.fn() }));
const init = Sentry.init as jest.Mock;

function makeEvent(over: Partial<ErrorEvent> = {}): ErrorEvent {
  return { type: undefined, ...over };
}

describe('instrument — PII 스크러빙', () => {
  it('1. request.data(자소서 본문)를 제거한다', () => {
    const event = makeEvent({
      request: {
        url: 'https://api.chwippo.com/ai/coverletter',
        data: { answer: '저는 백엔드 개발자로서 3년간...' },
      },
    });
    const out = scrubEvent(event);
    expect(out?.request?.data).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('백엔드 개발자');
  });

  it('2. URL 쿼리스트링을 절단한다 (OAuth code·state)', () => {
    const event = makeEvent({
      request: {
        url: 'https://api.chwippo.com/auth/kakao/callback?code=SECRET&state=x',
      },
    });
    const out = scrubEvent(event);
    expect(out?.request?.url).toBe(
      'https://api.chwippo.com/auth/kakao/callback',
    );
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('3. headers(Authorization)·cookies(refresh token)를 제거한다', () => {
    const event = makeEvent({
      request: {
        url: 'https://api.chwippo.com/users/me',
        headers: { authorization: 'Bearer eyJhbGciOi...' },
        cookies: { refresh_token: 'rt_secret_value' },
      },
    });
    const out = scrubEvent(event);
    expect(out?.request?.headers).toBeUndefined();
    expect(out?.request?.cookies).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('rt_secret_value');
  });

  it('4. user 는 id 만 남기고 이메일·닉네임을 제거한다', () => {
    const event = makeEvent({
      user: { id: 'u-1', email: 'me@example.com', username: '성원' },
    });
    expect(scrubEvent(event)?.user).toEqual({ id: 'u-1' });
  });

  it('5. 예외 message 를 cap 한다 (LLM 프롬프트 유출 차단)', () => {
    const prompt = '자소서 문항: '.repeat(300);
    const event = makeEvent({
      exception: { values: [{ type: 'Error', value: prompt }] },
    });
    const value = scrubEvent(event)?.exception?.values?.[0]?.value ?? '';
    expect(value.length).toBeLessThan(600);
    expect(value).toContain('(잘림)');
  });

  it('6. console breadcrumb 을 제거한다 (Logger 가 예외 객체를 찍는다)', () => {
    const event = makeEvent({
      breadcrumbs: [
        { category: 'console', message: '사용자 입력 전문...' },
        { category: 'http' },
      ],
    });
    const out = scrubEvent(event);
    expect(out?.breadcrumbs).toHaveLength(1);
    expect(out?.breadcrumbs?.[0].category).toBe('http');
  });

  it('7. breadcrumb URL 의 쿼리스트링을 절단한다', () => {
    const event = makeEvent({
      breadcrumbs: [
        {
          category: 'http',
          data: { url: 'https://x.test/v1?key=SECRET', method: 'POST' },
        },
      ],
    });
    const out = scrubEvent(event);
    expect(out?.breadcrumbs?.[0].data?.url).toBe('https://x.test/v1');
    expect(out?.breadcrumbs?.[0].data?.method).toBe('POST');
  });

  it('8. 빈 이벤트에도 안전하다', () => {
    expect(() => scrubEvent(makeEvent())).not.toThrow();
  });
});

describe('instrument — DSN 게이트', () => {
  beforeEach(() => init.mockReset());

  it('9. DSN 미설정이면 Sentry.init 을 호출하지 않는다 (로컬·CI 무영향)', () => {
    initSentry('');
    initSentry(undefined);
    expect(init).not.toHaveBeenCalled();
  });

  it('10. DSN 설정 시 quota·PII 안전값으로 init 한다', () => {
    initSentry('https://key@o0.ingest.sentry.io/1');

    expect(init).toHaveBeenCalledTimes(1);
    const cfg = init.mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.sendDefaultPii).toBe(false);
    expect(cfg.tracesSampleRate).toBe(0);
    expect(cfg.beforeSend).toBe(scrubEvent);

    // console breadcrumb 통합만 제거되고 나머지는 유지
    const integrations = (
      cfg.integrations as (d: { name: string }[]) => { name: string }[]
    )([{ name: 'Console' }, { name: 'Http' }]);
    expect(integrations.map((i) => i.name)).toEqual(['Http']);
  });
});
