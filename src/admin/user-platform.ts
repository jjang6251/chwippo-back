/**
 * 회원별 **사용 환경**(웹/앱) 판정 — 순수 함수.
 *
 * **왜 SQL 이 아니라 여기인가** — 판정 규칙(UA 에 앱 표식이 있는가)은 화면마다 달라지면 안 되고,
 * 목록·상세·대시보드 세 곳이 같은 규칙을 써야 합계가 맞는다. SQL 에 흩어두면 한 곳만 고쳐져
 * **"목록에선 앱인데 대시보드에선 웹"** 같은 어긋남이 생긴다.
 *
 * **판정 근거 2종은 서로 다른 것을 말한다:**
 *
 * | 근거 | 무엇을 뜻하나 |
 * |---|---|
 * | `refresh_sessions.device_info` (User-Agent) | **어떤 환경으로 로그인했나.** 앱은 UA 에 `chwippo-mobile-webview` 를 박는다 (`index.html` 의 native 감지와 같은 표식) |
 * | `user_devices` (푸시 토큰) | **푸시가 닿는가.** 앱 실행 + **알림 권한 허용**까지 해야 생긴다 |
 *
 * 그래서 앱 사용 여부는 UA 로 판정한다 — 푸시 토큰만 쓰면 **알림을 거부한 앱 사용자를 통째로
 * 놓친다.** 푸시 토큰은 "도달 가능" 이라는 별도 정보로만 쓴다.
 */

/** 앱 WebView 가 UA 에 박는 표식 (`chwippo-front/index.html` native 감지와 동일) */
export const APP_UA_MARKER = 'chwippo-mobile-webview';

export interface PlatformUsage {
  /** 앱(WebView)으로 로그인한 적 있음 */
  app: boolean;
  /** 브라우저로 로그인한 적 있음 */
  web: boolean;
}

/** 사용 환경 분류 — 대시보드 집계 단위. 서로 겹치지 않아야 합계가 전체와 맞는다. */
export type PlatformSegment = 'both' | 'app_only' | 'web_only' | 'none';

/**
 * UA 한 건이 앱인가.
 *
 * 🔴 **`null`·빈 문자열은 앱도 웹도 아니다.** UA 는 브라우저가 항상 보내므로 비어 있다는 건
 * 정상 로그인이 아니라는 뜻이다(API 클라이언트 등). 이를 웹으로 세면 **쓰지도 않은 웹 뱃지**가 붙는다.
 */
export function isAppUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return false;
  return ua.toLowerCase().includes(APP_UA_MARKER);
}

/** UA 한 건이 브라우저인가 (= 값이 있고 앱 표식이 없다) */
export function isWebUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return false;
  return !isAppUserAgent(ua);
}

/**
 * 한 사용자의 로그인 이력 → 사용 환경.
 *
 * **만료·폐기 세션을 포함한 전체 이력 기준이다** (CEO 확정 2026-08-04).
 * "지금 접속 가능한가" 가 아니라 **"어떤 환경을 쓰는 사람인가"** 를 알고 싶기 때문이다.
 *
 * 🔴 **다만 "영구" 는 아니다.** `SessionCleanupCron`(04:30 KST)이 만료·revoked 세션을
 * **삭제**하므로, 로그아웃 후 60일 넘게 안 들어온 사용자는 세션이 정리되면서
 * **뱃지가 `미접속` 으로 되돌아간다.** 즉 실제 보존 범위는 **세션 수명에 묶여 있다.**
 *
 * 의도(영구 유지)와 구현(세션 수명)의 차이를 **알고 현행 유지**하기로 했다 — 지금 규모에선
 * 세션이 살아 있어 체감 차이가 없고, 영구화는 마이그레이션 + 로그인 경로 5곳 수정이 필요하다.
 * 필요해지면 `users.first_app_login_at` · `first_web_login_at` 을 두고 로그인 시 1회만 찍는다
 * (조인이 사라져 조회도 빨라진다). 상세 = `data-schema.md` refresh_sessions 절.
 */
export function classifyUserAgents(uas: Array<string | null>): PlatformUsage {
  return {
    app: uas.some(isAppUserAgent),
    web: uas.some(isWebUserAgent),
  };
}

/** 대시보드 집계용 — 4분류 중 정확히 하나 */
export function toSegment(usage: PlatformUsage): PlatformSegment {
  if (usage.app && usage.web) return 'both';
  if (usage.app) return 'app_only';
  if (usage.web) return 'web_only';
  return 'none';
}
