import * as Sentry from '@sentry/nestjs';

/**
 * Sentry 초기화 — **main.ts 최상단에서 가장 먼저 import 되어야 한다.**
 * OpenTelemetry 계측이 다른 모듈보다 먼저 로드돼야 HTTP·DB 훅이 걸린다.
 *
 * 치뽀는 자소서 본문·실명·전화번호를 다루므로 기본 설정으로 붙이면 요청 본문이
 * 에러 컨텍스트로 전송된다. 개인정보처리방침(2026-08-04 시행) §1 이
 * "회원이 작성한 내용은 포함되지 않는다"고 공표하므로 아래 스크러빙은 방침 준수 의무다.
 *
 * SENTRY_DSN 미설정 시 완전 no-op — 로컬·CI·테스트 부팅 무영향 (REDIS_URL optional 과 같은 패턴).
 */

/** 예외 message 길이 상한 — LLM 프롬프트(자소서 본문 포함)가 예외로 새는 경로 차단 */
const MAX_MESSAGE_LEN = 500;

function stripQuery(url?: string): string | undefined {
  if (!url) return url;
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

function capText(text?: string): string | undefined {
  if (typeof text !== 'string') return text;
  return text.length > MAX_MESSAGE_LEN
    ? `${text.slice(0, MAX_MESSAGE_LEN)}… (잘림)`
    : text;
}

/**
 * 전송 직전 스크러빙. Sentry 기본값에 의존하지 않고 **명시적으로 삭제** —
 * SDK 버전이 올라가며 기본값이 바뀌어도 방침이 깨지지 않아야 한다.
 * export 하는 이유는 spec 에서 단위 검증하기 위함.
 */
export function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  if (event.request) {
    event.request.url = stripQuery(event.request.url);
    delete event.request.data; // 자소서 본문·내정보 입력값
    delete event.request.cookies; // refresh token
    delete event.request.headers; // Authorization Bearer
    delete event.request.query_string;
  }

  // user context 는 id 만 (이메일·닉네임은 방침상 전송 대상 아님)
  if (event.user) {
    event.user = { id: event.user.id };
  }

  event.message = capText(event.message);
  for (const ex of event.exception?.values ?? []) {
    ex.value = capText(ex.value);
  }

  // console breadcrumb 제거 — NestJS Logger 가 예외 객체를 통째로 찍는다
  event.breadcrumbs = (event.breadcrumbs ?? [])
    .filter((b) => b.category !== 'console')
    .map((b) => {
      const data = b.data;
      if (data && typeof data.url === 'string') {
        return { ...b, data: { ...data, url: stripQuery(data.url) } };
      }
      return b;
    });

  return event;
}

/** DSN 이 없으면 아무것도 하지 않는다. 인자는 spec 주입용 — 운영은 항상 env. */
export function initSentry(dsn = process.env.SENTRY_DSN): void {
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    sendDefaultPii: false,
    // 성능 추적 끔 — 무료 티어 quota 는 에러에만 쓴다
    tracesSampleRate: 0,
    // console breadcrumb 비활성 (AllExceptionsFilter 가 예외 객체를 logger.error 로 찍는다)
    integrations: (defaults) => defaults.filter((i) => i.name !== 'Console'),
    beforeSend: scrubEvent,
  });
}

// 모듈 로드 즉시 실행 — main.ts 가 이 파일을 첫 줄에서 import 하므로
// 다른 모듈보다 먼저 계측이 걸린다.
initSentry();
