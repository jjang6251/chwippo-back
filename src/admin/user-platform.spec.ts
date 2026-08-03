/**
 * 사용 환경 판정 — 순수 함수 spec.
 *
 * 이 규칙이 목록 뱃지·상세·대시보드 **세 곳의 공통 근거**라, 여기가 틀리면 세 화면이 한꺼번에
 * 틀리고 **합계가 전체 인원과 안 맞는다.**
 *
 * 시나리오:
 * - 앱 판정: 표식 포함 · 대소문자 · 실제 iOS/Android WebView UA
 * - 웹 판정: 데스크탑·모바일 브라우저 UA
 * - 🔴 부재: `null`·빈 문자열 → **앱도 웹도 아님** (웹으로 세면 없는 뱃지가 붙는다)
 * - 이력 롤업: 앱만 · 웹만 · 둘 다 · 없음
 * - 세그먼트: 4분류가 **서로 배타적**인가 (합계 = 전체 보장)
 */
import {
  APP_UA_MARKER,
  classifyUserAgents,
  isAppUserAgent,
  isWebUserAgent,
  toSegment,
} from './user-platform';

/** 실제 UA 형태 — 앱은 WebView UA 뒤에 표식을 덧붙인다 */
const APP_IOS = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ${APP_UA_MARKER}/1.0.0`;
const APP_ANDROID = `Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 ${APP_UA_MARKER}/1.0.0`;
const WEB_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const WEB_IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

describe('isAppUserAgent', () => {
  it('앱 WebView UA (iOS·Android) 를 앱으로 판정', () => {
    expect(isAppUserAgent(APP_IOS)).toBe(true);
    expect(isAppUserAgent(APP_ANDROID)).toBe(true);
  });

  it('대소문자가 달라도 판정한다', () => {
    expect(isAppUserAgent(`x ${APP_UA_MARKER.toUpperCase()} y`)).toBe(true);
  });

  it('브라우저 UA 는 앱이 아니다', () => {
    expect(isAppUserAgent(WEB_MAC)).toBe(false);
    expect(isAppUserAgent(WEB_IPHONE_SAFARI)).toBe(false);
  });

  /**
   * 🔴 아이폰 Safari 와 앱(iOS WebView)은 UA 앞부분이 거의 같다.
   * **표식이 유일한 구분점**이라 이걸 놓치면 앱 사용자가 웹으로 뒤집힌다.
   */
  it('아이폰 Safari 와 아이폰 앱을 구분한다', () => {
    expect(isAppUserAgent(APP_IOS)).toBe(true);
    expect(isAppUserAgent(WEB_IPHONE_SAFARI)).toBe(false);
  });
});

describe('부재 처리', () => {
  /** UA 는 브라우저가 항상 보낸다 — 비어 있다는 건 정상 로그인이 아니라는 뜻 */
  it.each([null, undefined, ''])('%p 은 앱도 웹도 아니다', (ua) => {
    expect(isAppUserAgent(ua as string | null)).toBe(false);
    expect(isWebUserAgent(ua as string | null)).toBe(false);
  });

  it('UA 가 하나도 없으면 segment 는 none', () => {
    expect(toSegment(classifyUserAgents([]))).toBe('none');
    expect(toSegment(classifyUserAgents([null, null]))).toBe('none');
  });
});

describe('classifyUserAgents — 로그인 이력 롤업', () => {
  it('앱으로만 로그인 → app_only', () => {
    expect(toSegment(classifyUserAgents([APP_IOS, APP_IOS]))).toBe('app_only');
  });

  it('브라우저로만 로그인 → web_only', () => {
    expect(toSegment(classifyUserAgents([WEB_MAC, WEB_IPHONE_SAFARI]))).toBe(
      'web_only',
    );
  });

  it('둘 다 → both', () => {
    expect(toSegment(classifyUserAgents([WEB_MAC, APP_ANDROID]))).toBe('both');
  });

  /** 순서가 판정을 바꾸면 안 된다 */
  it('이력 순서와 무관하다', () => {
    expect(classifyUserAgents([APP_IOS, WEB_MAC])).toEqual(
      classifyUserAgents([WEB_MAC, APP_IOS]),
    );
  });

  /** 값 없는 이력이 섞여도 있는 것만으로 판정 */
  it('null 이 섞여도 유효한 것만 본다', () => {
    expect(toSegment(classifyUserAgents([null, APP_IOS, null]))).toBe(
      'app_only',
    );
  });
});

describe('toSegment — 4분류 배타성', () => {
  /**
   * 🔴 **대시보드 합계가 전체 인원과 맞으려면 4분류가 배타적이어야 한다.**
   * 하나라도 겹치면 "웹만 + 앱만 + 둘다 + 미접속 > 전체" 가 되어 화면이 거짓말을 한다.
   */
  it('가능한 조합 4가지가 각각 다른 segment 로 간다', () => {
    const segments = [
      toSegment({ app: true, web: true }),
      toSegment({ app: true, web: false }),
      toSegment({ app: false, web: true }),
      toSegment({ app: false, web: false }),
    ];
    expect(segments).toEqual(['both', 'app_only', 'web_only', 'none']);
    expect(new Set(segments).size).toBe(4);
  });
});
