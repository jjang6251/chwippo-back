/**
 * 치뽀 백엔드 전역 시간·날짜 헬퍼.
 *
 * **정체성: 치뽀는 한국 취준생 KST-fixed app.**
 * 모든 quota 윈도우·집계는 KST (Asia/Seoul) 기준. 서버 OS TZ 와 무관.
 *
 * **확장 친화 시그니처**: 모든 헬퍼가 `tz?: string` 옵셔널 인자.
 * - 지금: 기본값 `APP_TIMEZONE` ('Asia/Seoul') → KST-fixed 동작
 * - 미래: 사용자별 TZ 지원 시 호출 측에서 `user.timezone` 전달
 *
 * 외부 dependency 0 — Node 18+ 표준 `Intl` 사용.
 */

export const APP_TIMEZONE = 'Asia/Seoul' as const;
export type Tz = string;

// ────────────────────────────────────────────────────────────────────────
// 내부 — Intl formatter 캐시
// ────────────────────────────────────────────────────────────────────────

const ymdFormatters = new Map<string, Intl.DateTimeFormat>();
function ymdFormatter(tz: Tz): Intl.DateTimeFormat {
  let f = ymdFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    ymdFormatters.set(tz, f);
  }
  return f;
}

const dtFormatters = new Map<string, Intl.DateTimeFormat>();
function datetimeFormatter(tz: Tz): Intl.DateTimeFormat {
  let f = dtFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    dtFormatters.set(tz, f);
  }
  return f;
}

/** target TZ 의 UTC offset 문자열 ('+09:00' 등) — KST 는 항상 '+09:00' */
function getTimezoneOffsetString(tz: Tz, atDate: Date = new Date()): string {
  // 'longOffset' 가 'GMT+09:00' 식으로 반환됨. KST 는 DST 없음
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'longOffset',
  });
  const parts = fmt.formatToParts(atDate);
  const part =
    parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  // 'GMT+09:00' → '+09:00'
  const m = part.match(/([+-]\d{2}:?\d{2})$/);
  if (!m) return '+00:00';
  return m[1].length === 5 ? m[1].slice(0, 3) + ':' + m[1].slice(3) : m[1];
}

/** 'YYYY-MM-DD' 의 요일 (0=일, 1=월, …, 6=토) — TZ 무관 */
function ymdDayOfWeek(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
}

/** YMD 에 일수 더한 결과 */
function ymdAddDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  const y2 = dt.getUTCFullYear();
  const m2 = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d2 = String(dt.getUTCDate()).padStart(2, '0');
  return `${y2}-${m2}-${d2}`;
}

// ────────────────────────────────────────────────────────────────────────
// 공개 — 기본
// ────────────────────────────────────────────────────────────────────────

/** Date → 'YYYY-MM-DD' (기본 KST) */
export function toKstDateString(
  d: Date = new Date(),
  tz: Tz = APP_TIMEZONE,
): string {
  return ymdFormatter(tz).format(d);
}

/** 오늘 'YYYY-MM-DD' (기본 KST) */
export function todayKst(tz: Tz = APP_TIMEZONE): string {
  return toKstDateString(new Date(), tz);
}

// ────────────────────────────────────────────────────────────────────────
// 윈도우 — quota / aggregation / scheduler 용 (Date 객체 반환)
// ────────────────────────────────────────────────────────────────────────

/**
 * 오늘 (기본 KST) 의 자정 시각을 UTC `Date` 로 반환.
 * NoteSummaryService 의 quota 윈도우 계산용.
 */
export function startOfTodayKst(tz: Tz = APP_TIMEZONE): Date {
  const ymd = todayKst(tz);
  const offset = getTimezoneOffsetString(tz);
  return new Date(`${ymd}T00:00:00${offset}`);
}

/** 오늘 (기본 KST) 의 끝 (다음날 자정 1ms 전) */
export function endOfTodayKst(tz: Tz = APP_TIMEZONE): Date {
  return new Date(startOfTodayKst(tz).getTime() + 24 * 60 * 60 * 1000 - 1);
}

/** 이번 달 1일 자정 (기본 KST) */
export function startOfMonthKst(tz: Tz = APP_TIMEZONE): Date {
  const ymd = todayKst(tz);
  const [y, m] = ymd.split('-');
  const offset = getTimezoneOffsetString(tz);
  return new Date(`${y}-${m}-01T00:00:00${offset}`);
}

/**
 * PR_B1 — 다음 매월 1일 0시 KST 의 `Date`.
 * 코인 시스템 의 Free tier 갱신 시각 (lazy reset / cron / 신규 user 가입 시) 계산용.
 */
export function startOfNextMonthKst(tz: Tz = APP_TIMEZONE): Date {
  const ymd = todayKst(tz);
  const [y, m] = ymd.split('-').map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const offset = getTimezoneOffsetString(tz);
  return new Date(
    `${nextY}-${String(nextM).padStart(2, '0')}-01T00:00:00${offset}`,
  );
}

/** 이번 달의 끝 (다음 달 1일 - 1ms) — KST 기준 month 가 UTC month 와 다른 edge (KST 매월 1일 0~9시 = UTC 전월) 대비 */
export function endOfMonthKst(tz: Tz = APP_TIMEZONE): Date {
  const ymd = todayKst(tz);
  const [y, m] = ymd.split('-').map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const offset = getTimezoneOffsetString(tz);
  const nextMonthStart = new Date(
    `${nextY}-${String(nextM).padStart(2, '0')}-01T00:00:00${offset}`,
  );
  return new Date(nextMonthStart.getTime() - 1);
}

// ────────────────────────────────────────────────────────────────────────
// 주 경계 — ISO 월요일 ~ 일요일
// ────────────────────────────────────────────────────────────────────────

/** 오늘 (또는 주어진 date) 가 속한 ISO 주의 월요일 'YYYY-MM-DD' (기본 KST) */
export function getKstWeekMonday(
  dateStr?: string,
  tz: Tz = APP_TIMEZONE,
): string {
  const base = dateStr ?? todayKst(tz);
  const day = ymdDayOfWeek(base);
  const diff = day === 0 ? -6 : 1 - day;
  return ymdAddDays(base, diff);
}

/** 이번 주의 일요일 'YYYY-MM-DD' */
export function getKstWeekSunday(
  dateStr?: string,
  tz: Tz = APP_TIMEZONE,
): string {
  return ymdAddDays(getKstWeekMonday(dateStr, tz), 6);
}

/** 이번 주 월요일 자정 (KST 기준) 의 `Date` 객체 — admin 통계·집계 윈도우용 */
export function startOfKstWeek(tz: Tz = APP_TIMEZONE): Date {
  const monday = getKstWeekMonday(undefined, tz);
  const offset = getTimezoneOffsetString(tz);
  return new Date(`${monday}T00:00:00${offset}`);
}

// ────────────────────────────────────────────────────────────────────────
// 표시
// ────────────────────────────────────────────────────────────────────────

/** Date → 'YYYY-MM-DD HH:mm:ss' (기본 KST) — admin·log·debug 표시용 */
export function formatKstDateTime(
  d: Date = new Date(),
  tz: Tz = APP_TIMEZONE,
): string {
  const parts = datetimeFormatter(tz).formatToParts(d);
  const pick = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}
