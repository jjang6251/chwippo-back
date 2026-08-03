/**
 * 회원별 **사용 환경**(웹/앱) 판정 — 순수 함수.
 *
 * 🔴 **UA 추측 → 로그인 경로 사실로 교체했다** (2026-08-04).
 *
 * 직전 구현은 `refresh_sessions.device_info` 에 `chwippo-mobile-webview` 표식이 있으면 앱으로
 * 판정했다. 그런데 그 표식은 **WebView 렌더링 감지용**이고, 앱의 로그인은 **네이티브 카카오/Apple
 * SDK** 로 이뤄져 **WebView 를 거치지 않는다.** 네이티브 HTTP 클라이언트가 보내는 요청이라 UA 에
 * 우리 표식이 없고, 결과적으로 **앱 사용자를 하나도 못 잡았다.**
 * `index.html` 의 native 감지 코드를 보고 "앱은 UA 에 표식을 박는다" 고 확인 없이 단정한 게 원인이다.
 *
 * 지금은 `users.first_app_login_at` · `first_web_login_at` 을 본다 —
 * **어느 엔드포인트로 들어왔는가** 라는 사실이 근거다 (`auth.controller` 스탬프 4곳):
 *
 * | 엔드포인트 | 판정 |
 * |---|---|
 * | `/auth/kakao/native` · `/auth/apple/native` | **앱** |
 * | `/auth/kakao/callback` · `/auth/apple/web/callback` | **웹** |
 * | `/auth/reviewer-login` | 스탬프 없음 (심사용 계정 — 통계 오염 방지) |
 *
 * **왜 순수 함수로 빼나** — 목록·상세·대시보드 세 곳이 같은 규칙을 써야 한다. SQL 에 흩어두면
 * 한 곳만 고쳐져 **"목록에선 앱인데 대시보드에선 웹"** 같은 어긋남이 생기고 합계가 안 맞는다.
 *
 * **푸시 도달 가능 여부는 별개 축이다** (`user_devices`). 앱을 쓰지만 **알림을 거부**한 사용자는
 * `app=true` 지만 푸시가 안 닿는다 — 브리핑·마감 알림을 보내도 도달하지 않으므로,
 * "안 본 건지 애초에 안 닿은 건지" 를 구분하려면 따로 봐야 한다.
 */

export interface PlatformUsage {
  /** 앱(네이티브 SDK)으로 로그인한 적 있음 */
  app: boolean;
  /** 브라우저로 로그인한 적 있음 */
  web: boolean;
}

/** 사용 환경 분류 — 대시보드 집계 단위. 서로 겹치지 않아야 합계가 전체와 맞는다. */
export type PlatformSegment = 'both' | 'app_only' | 'web_only' | 'none';

/**
 * 로그인 스탬프 → 사용 환경.
 *
 * `null` = 그 경로로 로그인한 적 없음. 스탬프는 **최초 1회만** 찍히므로 값의 유무만 본다
 * (최근성이 아니라 "쓴 적 있는가" 가 질문이다).
 */
export function classifyLoginStamps(
  firstAppLoginAt: Date | string | null | undefined,
  firstWebLoginAt: Date | string | null | undefined,
): PlatformUsage {
  return { app: !!firstAppLoginAt, web: !!firstWebLoginAt };
}

/** 대시보드 집계용 — 4분류 중 정확히 하나 */
export function toSegment(usage: PlatformUsage): PlatformSegment {
  if (usage.app && usage.web) return 'both';
  if (usage.app) return 'app_only';
  if (usage.web) return 'web_only';
  return 'none';
}
