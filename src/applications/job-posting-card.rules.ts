import type {
  PostingDeadlineKind,
  PostingJobPicked,
} from './application.entity';

/**
 * 공고 → 카드 **서버 규칙** (대장 21 · 2026-08-29).
 *
 * LLM 응답은 신뢰 경계 **밖**이다. 이 모듈은 그 밖의 값을 안쪽 타입으로 바꾸는 유일한 통로이며,
 * `as` 단언을 쓰지 않는다 (ADR-058 — 2026-08-01 자소서 점검 크래시가 정확히 그 모양이었다).
 *
 * Nest 의존이 하나도 없는 **순수 함수 모음**이다. 날짜 규칙은 시뮬레이션(5시점 × 연도 유무)을
 * 돌려야 검증되는데, 서비스에 묻어 있으면 그 시뮬레이션을 짜려고 DI 컨테이너를 띄워야 한다.
 */

// ────────────────────────────────────────────────────────────────────────
// 타입 — LLM 이 주는 모양 (전부 옵셔널·전부 의심)
// ────────────────────────────────────────────────────────────────────────

export interface ParsedDateObj {
  year: number | null;
  month: number | null;
  day: number | null;
  /** 'HH:mm' */
  time: string | null;
  /** '목요일' — 적혀 있을 때만. 연도 앵커 tie-break 에 쓰인다 (정정 14 ⑨) */
  weekday: string | null;
}

export interface ParsedStep {
  name: string;
  date: ParsedDateObj | null;
  dateHint: string | null;
}

export interface CardLlmOutput {
  notPosting: boolean;
  companyName: string | null;
  jobTitles: string[];
  postingYear: number | null;
  jobUrl: string | null;
  deadline: ParsedDateObj | null;
  deadlineKind: PostingDeadlineKind;
  steps: ParsedStep[];
  responsibilities: string;
  requirements: string[];
  preferred: string[];
  techStack: string[];
  qualifications: string[];
  keywords: string[];
}

/** 카드가 될 전형 스텝 (`application_steps` 한 행) */
export interface DraftStep {
  name: string;
  /** 'YYYY-MM-DD' 또는 'YYYY-MM-DDTHH:mm' (KST 벽시각) */
  date: string | null;
  dateHint: string | null;
}

/** 스텝이 아니라 캘린더 메모(daily_notes)로 갈 날짜 */
export interface DraftExtraDate {
  label: string;
  /** 'YYYY-MM-DD' */
  date: string;
  /** 'HH:mm' — hour_slot 계산용. null = 시각 없음(당일 아침 브리핑만) */
  time: string | null;
}

/** 파싱 결과 한 장 — Redis 초안 + 카드 생성 입력 (원문 rawText 는 어디에도 없다) */
export interface CardDraft {
  companyName: string | null;
  jobTitle: string | null;
  /** 공고가 뽑은 직무 표기 전부 (보완 질문 후보) */
  jobTitles: string[];
  /** 프로필 희망 직무와 글자가 맞은 후보 — 프론트가 「내 직무와 가까움」 배지로 쓴다 */
  nearProfile: string[];
  jobPicked: PostingJobPicked | null;
  companySource: 'parsed' | 'typed';
  deadline: string | null;
  deadlineKind: PostingDeadlineKind;
  jobUrl: string | null;
  steps: DraftStep[];
  extraDates: DraftExtraDate[];
  jobPosting: {
    responsibilities: string | null;
    requirements: string[];
    preferred: string[];
    techStack: string[];
    qualifications: string[];
    keywords: string[];
  } | null;
  orderConflict: boolean;
  postingYear: number | null;
  notPosting: boolean;
  /** AI 가 실제로 채운 칸 — `posting_meta.filled` */
  filled: string[];
}

// ────────────────────────────────────────────────────────────────────────
// 상수
// ────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** 지난 마감도 조금은 살려 둔다 — 어제 마감 공고를 붙이는 일이 실제로 있다 */
export const PAST_GRACE_DAYS = 30;
/** 1년 넘게 뒤 날짜는 파싱 오류로 본다 (연도 앵커가 잘못 잡힌 경우) */
export const FUTURE_LIMIT_DAYS = 365;
/** 스텝 상한 — 「최종 합격」 포함 (정정 2) */
export const STEP_CAP = 10;
export const MAX_NAME_LEN = 30;
export const MAX_HINT_LEN = 40;
export const MAX_COMPANY_LEN = 100;
export const MAX_JOB_TITLE_LEN = 100;
/** 보완 질문 후보 상한 (정정 4 — 검색칸 없이 훑을 수 있는 길이) */
export const MAX_JOB_CANDIDATES = 15;
export const MAX_JOB_URL_LEN = 500;

const WEEKDAY_INDEX: Record<string, number> = {
  일: 0,
  월: 1,
  화: 2,
  수: 3,
  목: 4,
  금: 5,
  토: 6,
};

// ────────────────────────────────────────────────────────────────────────
// 입력 위생
// ────────────────────────────────────────────────────────────────────────

/**
 * 붙여넣은 원문 위생 — 제어문자·zero-width 제거.
 *
 * 🔴 zero-width(U+200B~200D·FEFF·2060) 는 **눈에 안 보이면서 토큰을 먹고**, 프롬프트 경계
 * (코드블록 펜스)를 흉내 내는 데 쓰일 수 있다. 줄바꿈·탭은 공고 구조 그 자체라 남긴다.
 */
export function sanitizePastedText(raw: string): string {
  return (
    raw
      // zero-width space·non-joiner·joiner · word joiner · BOM — 눈에 안 보이면서 토큰을 먹고
      // 프롬프트 경계(코드블록 펜스)를 흉내 내는 데 쓰일 수 있다
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      // C0·C1 제어문자 + DEL. 줄바꿈(\n)·탭(\t)·캐리지리턴(\r)은 공고 구조 그 자체라 남긴다
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
      .trim()
  );
}

/**
 * 공고에서 뽑은 링크 — **http(s) 만** 통과시킨다.
 *
 * 🔴 `javascript:`·`data:` 스킴이 `jobUrl` 에 들어가면 그 값을 그대로 `<a href>` 에 쓰는
 * 화면에서 클릭 한 번에 스크립트가 돈다. LLM 이 만든 값이라 신뢰 경계 밖이고,
 * 「원문에 있던 것」이라는 이유로 통과시킬 근거가 없다.
 */
export function sanitizeJobUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.length > MAX_JOB_URL_LEN) return null;
  if (!/^https?:\/\/\S+$/i.test(v)) return null;
  return v;
}

// ────────────────────────────────────────────────────────────────────────
// normalize — 신뢰 경계 밖 → 안
// ────────────────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === 'string')
    : [];
}

function asIntOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function normalizeDateObj(v: unknown): ParsedDateObj | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = asRecord(v);
  const month = asIntOrNull(o.month);
  const day = asIntOrNull(o.day);
  const year = asIntOrNull(o.year);
  return {
    // 범위 밖 월·일은 여기서 버린다 (13월·32일 — strict 스키마가 integer 만 보장한다)
    year: year !== null && year >= 1900 && year <= 2999 ? year : null,
    month: month !== null && month >= 1 && month <= 12 ? month : null,
    day: day !== null && day >= 1 && day <= 31 ? day : null,
    time: normalizeTime(o.time),
    weekday: asStringOrNull(o.weekday),
  };
}

/** 'HH:mm' 만 통과. '24:00' 은 '23:59' 로 (그날의 끝이지 다음날이 아니다) */
export function normalizeTime(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '24:00') return '23:59';
  if (!/^\d{2}:\d{2}$/.test(t)) return null;
  const [h, m] = t.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return t;
}

/**
 * LLM 응답 → `CardLlmOutput`. **검증을 통과시킨 뒤에 타입을 확정한다.**
 * `steps` 가 문자열 배열로 오거나 `deadline` 이 문자열이어도 여기서 죽지 않는다.
 */
export function normalizeCardOutput(raw: unknown): CardLlmOutput {
  const o = asRecord(raw);
  const kindRaw = o.deadlineKind;
  const deadlineKind: PostingDeadlineKind =
    kindRaw === 'fixed' || kindRaw === 'rolling' || kindRaw === 'unknown'
      ? kindRaw
      : 'unknown';

  const steps: ParsedStep[] = (Array.isArray(o.steps) ? o.steps : [])
    .map((s): ParsedStep | null => {
      const so = asRecord(s);
      const name = typeof so.name === 'string' ? so.name.trim() : '';
      if (!name) return null;
      return {
        name,
        date: normalizeDateObj(so.date),
        dateHint: asStringOrNull(so.dateHint),
      };
    })
    .filter((s): s is ParsedStep => s !== null);

  return {
    notPosting: o.notPosting === true,
    companyName: asStringOrNull(o.companyName),
    jobTitles: asStringArray(o.jobTitles)
      .map((s) => s.trim())
      .filter(Boolean),
    postingYear: (() => {
      const y = asIntOrNull(o.postingYear);
      return y !== null && y >= 1900 && y <= 2999 ? y : null;
    })(),
    jobUrl: sanitizeJobUrl(o.jobUrl),
    deadline: normalizeDateObj(o.deadline),
    deadlineKind,
    steps,
    responsibilities:
      typeof o.responsibilities === 'string' ? o.responsibilities.trim() : '',
    requirements: asStringArray(o.requirements),
    preferred: asStringArray(o.preferred),
    techStack: asStringArray(o.techStack),
    qualifications: asStringArray(o.qualifications),
    keywords: asStringArray(o.keywords),
  };
}

// ────────────────────────────────────────────────────────────────────────
// 날짜 — 연도 앵커 + 순서 단조 (정정 13)
// ────────────────────────────────────────────────────────────────────────

function utcMs(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}

/** 2월 30일 같은 「없는 날짜」 걸러내기 — Date.UTC 는 조용히 3월로 넘긴다 */
function isRealDate(y: number, m: number, d: number): boolean {
  const dt = new Date(utcMs(y, m, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

interface ChainEntry {
  /** 원본 배열에서의 위치 */
  index: number;
  year: number | null;
  month: number;
  day: number;
  time: string | null;
  weekday: string | null;
}

interface ChainResolved {
  index: number;
  ms: number;
  iso: string;
  /** 앵커 tie-break 용 — 배열 위치가 아니라 값에 붙여 둔다 (없는 날짜는 건너뛰므로 인덱스가 어긋난다) */
  weekday: string | null;
}

/**
 * 앵커 연도 하나를 가정하고 **순서 단조**로 연도를 전파한다.
 *
 * 규칙: 이전 날짜보다 **작아지지 않는 최소 연도**를 고른다.
 * 11/23 → 12/2 → 1/2 이면 2026 · 2026 · 2027 이 된다. 날짜 옆에 4자리 연도가
 * 직접 적혀 있으면 그 값이 이기고, 그 자리부터 앵커가 다시 잡힌다.
 */
function propagate(entries: ChainEntry[], firstYear: number): ChainResolved[] {
  const out: ChainResolved[] = [];
  let prevMs = Number.NEGATIVE_INFINITY;
  let curYear = firstYear;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    let y: number;
    if (e.year !== null) {
      y = e.year;
    } else {
      y = i === 0 ? firstYear : curYear;
      // 이전 날짜 이상이 될 때까지 해를 넘긴다. 월·일은 12개월 안에 반드시 한 번
      // 돌아오므로 최대 1회면 끝나지만, 방어적으로 2회까지만 허용한다.
      let guard = 0;
      while (
        prevMs !== Number.NEGATIVE_INFINITY &&
        utcMs(y, e.month, e.day) < prevMs &&
        guard < 2
      ) {
        y += 1;
        guard += 1;
      }
    }
    const ms = utcMs(y, e.month, e.day);
    if (!isRealDate(y, e.month, e.day)) continue; // 없는 날짜 → 이 자리는 비운다
    const time = e.time ? `T${e.time}` : '';
    out.push({
      index: e.index,
      ms,
      iso: `${y}-${pad2(e.month)}-${pad2(e.day)}${time}`,
      weekday: e.weekday,
    });
    prevMs = ms;
    curYear = y;
  }
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function weekdayMatches(ms: number, weekday: string | null): boolean {
  if (!weekday) return false;
  const ch = weekday.trim().charAt(0);
  const want = WEEKDAY_INDEX[ch];
  if (want === undefined) return false;
  return new Date(ms).getUTCDay() === want;
}

/**
 * 날짜 객체 배열 → ISO 문자열 배열 (자리 보존 · 해석 불가는 null).
 *
 * ## 🔴 왜 「날짜마다 독립 해석」을 버렸나 (정정 13)
 *
 * 이전 규칙은 날짜마다 「가장 가까운 미래」로 연도를 붙였다. 그러면 **11월 공고를 12/30 에
 * 붙이는 순간** 서류 마감 11/23 은 2027 로, 필기 12/2 도 2027 로, 면접 1/2 도 2027 로 가서
 * 순서는 맞는데 **전부 1년 뒤**가 된다. 반대로 8/29 에 붙이면 11/23·12/2 는 2026, 1/2 는
 * 2027 로 잘 나온다 — 같은 공고가 붙이는 날에 따라 다른 카드가 되는 셈이다.
 *
 * ## 앵커 순서
 *
 * 1. 날짜 옆에 4자리 연도가 있으면 **그 값이 이긴다** (그 자리부터 앵커 재설정)
 * 2. 없으면 첫 날짜의 연도 = `postingYear` (공고 제목·본문의 연도)
 * 3. 둘 다 없으면 후보 {작년·올해·내년} 중
 *    ① 범위(오늘−30일 ~ +365일) 안에 드는 날짜가 **최다**인 해
 *    ② 동점이면 **요일이 맞는** 해 (정정 14 ⑨ — 공고에 「(목)」이 적혀 있으면 결정적이다)
 *    ③ 그래도 동점이면 첫 날짜가 오늘과 가장 가까운 해
 * 4. 정해진 앵커에서 **순서 단조**로 전파 (이전 날짜 이상이 되는 최소 연도)
 * 5. 마지막에 각 날짜를 범위로 검증 — 밖이면 null (지난 단계는 정직하게 비운다)
 */
export function resolveDateChain(
  dates: (ParsedDateObj | null)[],
  postingYear: number | null,
  todayKst: string,
): (string | null)[] {
  const result: (string | null)[] = dates.map(() => null);

  const entries: ChainEntry[] = [];
  dates.forEach((d, index) => {
    // month 없음 = 날짜 아님 · day 없음 = 「9월 초」류라 날짜로 확정하지 않는다
    if (!d || d.month === null || d.day === null) return;
    entries.push({
      index,
      year: d.year,
      month: d.month,
      day: d.day,
      time: d.time,
      weekday: d.weekday,
    });
  });
  if (entries.length === 0) return result;

  const [ty, tm, td] = todayKst.split('-').map(Number);
  const todayMs = utcMs(ty, tm, td);
  const lo = todayMs - PAST_GRACE_DAYS * DAY_MS;
  const hi = todayMs + FUTURE_LIMIT_DAYS * DAY_MS;
  const inRange = (ms: number) => ms >= lo && ms <= hi;

  let resolved: ChainResolved[];
  if (entries[0].year !== null) {
    // 첫 날짜에 연도가 박혀 있으면 후보 탐색이 필요 없다
    resolved = propagate(entries, entries[0].year);
  } else if (postingYear !== null) {
    resolved = propagate(entries, postingYear);
  } else {
    const candidates = [ty - 1, ty, ty + 1];
    let best: { r: ChainResolved[]; score: [number, number, number] } | null =
      null;
    for (const c of candidates) {
      const r = propagate(entries, c);
      const hits = r.filter((x) => inRange(x.ms)).length;
      const wd = r.filter((x) => weekdayMatches(x.ms, x.weekday)).length;
      const closeness =
        r.length > 0 ? -Math.abs(r[0].ms - todayMs) : Number.NEGATIVE_INFINITY;
      const score: [number, number, number] = [hits, wd, closeness];
      if (
        !best ||
        score[0] > best.score[0] ||
        (score[0] === best.score[0] &&
          (score[1] > best.score[1] ||
            (score[1] === best.score[1] && score[2] > best.score[2])))
      ) {
        best = { r, score };
      }
    }
    resolved = best?.r ?? [];
  }

  for (const r of resolved) {
    if (!inRange(r.ms)) continue; // 범위 밖 → null 로 남긴다 (지어내지 않는다)
    result[r.index] = r.iso;
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────────
// 힌트·이름 정리
// ────────────────────────────────────────────────────────────────────────

/** 「목요일」·「(목)」처럼 **요일만** 있는 힌트 — 날짜가 이미 말해 주는 정보다 */
function isWeekdayOnlyHint(hint: string): boolean {
  return /^[(（\s]*[일월화수목금토][\s]*(요일)?[)）\s]*$/.test(hint);
}

/**
 * 스텝 힌트 정리 (서버 규칙 ④).
 * - trim · 40자 컷
 * - 요일만 있으면 버린다
 * - 날짜가 이미 확정됐고 힌트가 **그 날짜의 반복**(숫자와 구분자뿐)이면 버린다
 */
export function cleanDateHint(
  hint: string | null,
  resolvedDate: string | null,
): string | null {
  if (!hint) return null;
  const t = hint.trim();
  if (!t) return null;
  if (isWeekdayOnlyHint(t)) return null;
  if (resolvedDate) {
    // 숫자·구분자·년월일·시분초·요일만 남는 힌트는 날짜의 되풀이다 ("07월 05일 24:00 까지")
    const rest = t
      .replace(/[0-9\s./\-~:()（）]/g, '')
      .replace(/[년월일시분초까지부터]/g, '')
      .replace(/[일월화수목금토]?요일/g, '');
    if (!rest) return null;
  }
  return t.slice(0, MAX_HINT_LEN);
}

/** 「원서 접수」·「입사지원서 접수」 → 「서류 접수」 (서버 규칙 ⑫ — 나머지 이름은 원문 유지) */
export function normalizeStepName(name: string): string {
  const t = name.trim().slice(0, MAX_NAME_LEN);
  if (/접수/.test(t) && !/발표/.test(t)) return '서류 접수';
  return t;
}

/** 「최종 합격」류인가 — 「서류 합격 발표」가 여기 걸리면 카드가 통째로 잘린다 */
export function isFinalStepName(name: string): boolean {
  const n = name.replace(/\s/g, '');
  if (/^합격자발표$/.test(n)) return true;
  return /최종/.test(n) && /(합격|발표|선발|결과)/.test(n);
}

/**
 * 입사 **이후** 절차 — 지원의 끝(최종 합격) 다음이라 카드에 들어갈 자리가 없다.
 * 「채용형 인턴 운영」·「정규직 임용」·「처우 협의」·「입사 OT」.
 */
const POST_HIRE_RE =
  /입사|임용|채용형\s*인턴|오리엔테이션|(^|\s)OT($|\s)|연수|처우\s*협의|근로\s*계약|수습\s*평가/;

export type ParsedStepKind = 'step' | 'note' | 'drop';

/**
 * 스텝인가, 캘린더 일정인가, 버릴 것인가 (정정 11 + 정정 2).
 *
 * **「내가 하는 것은 스텝, 기다리거나 가는 날은 일정」**
 * - 최종 합격 그 자체 → 마지막 **스텝** (카드의 종착점)
 * - 최종 **뒤** 절차(신체검사·입사·OT) → **일정** — 날짜는 하나도 안 버린다(정정 11)
 * - 합격 발표류 → **일정** (내가 하는 일이 아니라 기다리는 날이다)
 * - 최종 **앞** 검진 → 스텝 (전형의 일부다 — R5 KT&G 「채용검진」)
 *
 * 🔴 `drop` 이 따로 있는 이유 — **공고에 「최종 합격」이 안 적힌 경우**가 실제로 많다
 * (실측: 코레일은 「…면접시험 → 채용형 인턴 운영 → 정규직 임용」으로 끝난다).
 * 위치 규칙만 쓰면 그 둘이 전형 스텝으로 남아 스텝 바에 「정규직 임용」이 뜬다.
 * 이름으로 「입사 이후」를 알아볼 수 있을 때는 위치와 무관하게 버린다.
 *
 * @param finalIndex 파싱 스텝 중 「최종 합격」류의 위치. 없으면 -1
 */
export function classifyParsedStep(
  name: string,
  index: number,
  finalIndex: number,
): ParsedStepKind {
  if (finalIndex >= 0 && index === finalIndex) return 'step';
  if (finalIndex >= 0 && index > finalIndex) return 'note';
  if (finalIndex < 0 && POST_HIRE_RE.test(name)) return 'drop';
  if (/발표/.test(name)) return 'note';
  return 'step';
}

/** 「(주)·㈜·주식회사」 접두/접미 제거 (서버 규칙 ⑪ — 조사 시드·자동완성 매칭 키와 맞춘다) */
export function stripCompanyAffix(raw: string): string {
  return raw
    .replace(/^\s*(\(주\)|（주）|㈜|주식회사)\s*/g, '')
    .replace(/\s*(\(주\)|（주）|㈜|주식회사)\s*$/g, '')
    .trim();
}

// ────────────────────────────────────────────────────────────────────────
// 직무 매칭 (정정 4)
// ────────────────────────────────────────────────────────────────────────

/**
 * 동의어 소사전 — **아주 작게 둔다.**
 * 넓히면 「백엔드 개발자」와 「데이터 엔지니어」가 같은 직무로 접혀 **자동 확정**되고,
 * 그건 사용자가 하지 않은 말을 카드에 적는 것이다.
 */
const JOB_SYNONYMS: string[][] = [
  ['개발자', '엔지니어', 'developer', 'engineer'],
  ['디자이너', '디자인', 'designer'],
  ['마케터', '마케팅', 'marketer', 'marketing'],
  ['기획자', '기획'],
];

function normalizeJobKey(raw: string): string {
  let s = raw.toLowerCase().replace(/[\s·・.,/()[\]{}·\-_]/g, '');
  JOB_SYNONYMS.forEach((group, gi) => {
    // 긴 별칭부터 치환 — 짧은 것이 먼저 먹으면 긴 별칭이 안 걸린다
    for (const alias of [...group].sort((a, b) => b.length - a.length)) {
      s = s.split(alias).join(`§${gi}`);
    }
  });
  return s;
}

/** 양방향 포함 — 「마케터」 ⊂ 「브랜드 마케터」 */
function looseMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export interface JobResolution {
  jobTitle: string | null;
  /** 보완 질문 후보 (needs:'job' 일 때만 의미 있음) */
  candidates: string[];
  /** 프로필과 글자가 맞은 후보 — 후보 목록 맨 위 + 배지 */
  nearProfile: string[];
  picked: PostingJobPicked | null;
  needsJob: boolean;
}

/**
 * 어느 직무로 카드를 만들 것인가.
 *
 * 1. 사용자가 **골랐으면**(`jobContext`) 그것 — 후보에 있으면 `chosen`, 직접 적었으면 `typed`
 * 2. 공고가 뽑은 직무가 **하나뿐**이면 그것 (`single`)
 * 3. 프로필 희망 직무와 글자가 **정확히 하나에만** 맞으면 그것 (`profile`)
 *    🔴 여럿에 걸리면 자동 확정하지 않는다 — 「브랜드/퍼포먼스/콘텐츠 마케터」 셋에 걸린
 *    「마케터」로 아무거나 고르면 **요건이 통째로 다른 부문**의 카드가 만들어진다
 * 4. 그 외 여럿이면 물어본다 (`needsJob`)
 * 5. 하나도 없으면 직무 없는 카드 (물어볼 후보가 없다)
 */
/**
 * 고용 형태·채용 프로그램/전형명 — **직무가 아닌 말** (CEO 실기 2026-08-29: SK하이닉스
 * 「Talent hy-way(신입)」 공고가 직무 「신입」/「Talent hy-way(신입)」 으로 들어왔다).
 * 프롬프트가 같은 규칙을 갖지만, 모델은 규칙을 어기므로 서버가 한 번 더 거른다.
 */
const NON_JOB_WORD =
  /^(신입|경력|인턴|사원|직원|신입사원|경력사원|계약직|정규직|수시|공채|공개채용|채용|모집|지원자|신입\s*채용|경력\s*채용)$/;
/** 「백엔드 개발자(신입)」·「객실승무원 (경력)」 의 고용 형태 괄호 접미 */
const EMPLOYMENT_SUFFIX_RE =
  /\s*[(（]\s*(신입|경력|인턴|계약직|정규직)\s*[)）]\s*$/;
/**
 * 「신입 백엔드 개발자」·「신입행원」 의 고용 형태 접두. 띄어쓰기 없이 붙은 것도 뗀다 (스윕 F30) —
 * 단 뒤에 2글자 이상 남을 때만 (「경력직」「신입생」은 그대로) 이고 「인턴십」은 접두가 아니다.
 */
const EMPLOYMENT_PREFIX_RE = /^(신입|경력|인턴)(?!십)\s*(?=[가-힣A-Za-z]{2,})/;
/** 「사무 신입사원」「현장 경력사원」 의 고용 형태 꼬리 — 앞에 부문명이 남을 때만 뗀다 (KT&G R5) */
const EMPLOYMENT_TAIL_RE =
  /\s+(신입사원|경력사원|신입|경력|인턴|계약직|정규직)$/;

/**
 * 직무 후보 정제 — 고용 형태만 남는 값은 버리고, 접두·접미 고용 형태는 뗀다.
 * 「사람 말만 볼펜」: 지어낼 바에는 비운다 (직무 null 카드가 「신입」 직무 카드보다 낫다).
 */
export function cleanJobTitles(rawTitles: string[]): string[] {
  const out: string[] = [];
  for (const raw of rawTitles) {
    let t = raw.trim().slice(0, MAX_JOB_TITLE_LEN);
    // 통째로 고용 형태(「신입사원」「경력사원」)면 떼기 전에 버린다 — 접두 규칙이 「사원」을 남긴다
    if (!t || NON_JOB_WORD.test(t.replace(/\s+/g, ' '))) continue;
    // 🔴 인턴 채용은 「객실승무원(인턴)」 표기를 **유지**한다 (정정 14 ⑦) — 접미 제거는 신입·경력·계약직·정규직만
    if (!/[(（]\s*인턴\s*[)）]\s*$/.test(t))
      t = t.replace(EMPLOYMENT_SUFFIX_RE, '');
    t = t
      .replace(EMPLOYMENT_PREFIX_RE, '')
      .replace(EMPLOYMENT_TAIL_RE, '')
      .trim();
    if (!t || NON_JOB_WORD.test(t.replace(/\s+/g, ' '))) continue;
    out.push(t);
  }
  return out;
}

export function resolveJob(
  rawTitles: string[],
  jobContext: string | null,
  profileTitle: string | null,
): JobResolution {
  const titles = Array.from(new Set(cleanJobTitles(rawTitles))).slice(
    0,
    MAX_JOB_CANDIDATES,
  );

  const empty: JobResolution = {
    jobTitle: null,
    candidates: [],
    nearProfile: [],
    picked: null,
    needsJob: false,
  };

  const profileKey = profileTitle ? normalizeJobKey(profileTitle) : '';
  const nearProfile = profileKey
    ? titles.filter((t) => looseMatch(normalizeJobKey(t), profileKey))
    : [];

  if (jobContext) {
    const ctx = jobContext.trim().slice(0, MAX_JOB_TITLE_LEN);
    if (ctx) {
      const ctxKey = normalizeJobKey(ctx);
      const hit = titles.find((t) => looseMatch(normalizeJobKey(t), ctxKey));
      // 후보에 있으면 **공고 표기 그대로** 쓴다 (정정 4 ②-c — 카드 직무 칸은 언제나 공고 표기)
      return {
        ...empty,
        jobTitle: hit ?? ctx,
        picked: hit ? 'chosen' : 'typed',
        nearProfile,
      };
    }
  }

  if (titles.length === 0) return { ...empty, nearProfile };
  if (titles.length === 1) {
    return { ...empty, jobTitle: titles[0], picked: 'single', nearProfile };
  }
  if (nearProfile.length === 1) {
    return {
      ...empty,
      jobTitle: nearProfile[0],
      picked: 'profile',
      nearProfile,
    };
  }

  // 후보 정렬 — 프로필과 가까운 것을 위로 (순서만 바꾼다, 내용은 공고 표기 그대로)
  const ordered = [
    ...nearProfile,
    ...titles.filter((t) => !nearProfile.includes(t)),
  ];
  return {
    jobTitle: null,
    candidates: ordered,
    nearProfile,
    picked: null,
    needsJob: true,
  };
}

// ────────────────────────────────────────────────────────────────────────
// 스텝 조립
// ────────────────────────────────────────────────────────────────────────

interface BuiltSteps {
  steps: DraftStep[];
  extraDates: DraftExtraDate[];
  orderConflict: boolean;
}

/** 'YYYY-MM-DDTHH:mm' → { date, time } */
export function splitIso(iso: string): { date: string; time: string | null } {
  const [d, t] = iso.split('T');
  return { date: d, time: t ?? null };
}

function isoMs(iso: string | null): number | null {
  if (!iso) return null;
  const [y, m, d] = splitIso(iso).date.split('-').map(Number);
  return utcMs(y, m, d);
}

/**
 * 파싱 스텝 → 카드 스텝 + 캘린더 일정.
 *
 * 순서: 이름 정리 → 최종 합격 자르기·통일 → 분류(스텝/일정) → 최종 합격 보장 →
 *       상한(전형 9 + 최종 1) → 첫 접수 = 마감 → 동명 번호 → 날짜순 정렬·역전 감지
 */
export function buildSteps(
  parsed: ParsedStep[],
  resolvedDates: (string | null)[],
  deadlineIso: string | null,
  deadlineHint: string | null,
): BuiltSteps {
  interface Work {
    name: string;
    date: string | null;
    dateHint: string | null;
  }

  const work: Work[] = parsed.map((s, i) => {
    const date = resolvedDates[i] ?? null;
    return {
      name: normalizeStepName(s.name),
      date,
      dateHint: cleanDateHint(s.dateHint, date),
    };
  });

  // ── 최종 합격 정규화 (정정 2) — 그 자리에서 자르고 이름을 통일한다.
  //    뒤에 붙은 채용형 인턴·정규직 임용·처우 협의는 「지원의 끝」 다음이라 카드 밖이다.
  const finalIndex = work.findIndex((s) => isFinalStepName(s.name));

  const steps: DraftStep[] = [];
  const extraDates: DraftExtraDate[] = [];

  work.forEach((s, i) => {
    const kind = classifyParsedStep(s.name, i, finalIndex);
    if (kind === 'drop') return;
    if (kind === 'step') {
      steps.push({
        name: i === finalIndex ? '최종 합격' : s.name,
        date: s.date,
        dateHint: s.dateHint,
      });
      return;
    }
    // 🔴 일정으로 보내려면 **날짜가 있어야 한다** (`daily_notes.date` 는 NOT NULL).
    if (s.date) {
      const { date, time } = splitIso(s.date);
      extraDates.push({ label: s.name, date, time });
      return;
    }
    // 날짜 없는 **발표**는 버리지 않는다 — 「서류 발표 [추후 공지]」의 그 힌트가 사용자가
    // 「언제쯤 다시 확인해야 하나」를 아는 유일한 근거다. 캘린더에 못 넣으니 스텝으로 남긴다.
    if (/발표/.test(s.name)) {
      steps.push({ name: s.name, date: null, dateHint: s.dateHint });
      return;
    }
    // 최종 뒤 절차(신체검사·입사)인데 날짜조차 없으면 남길 자리도, 남길 정보도 없다
  });

  // ── 마지막은 무조건 「최종 합격」 (규칙 3)
  if (!steps.some((s) => s.name === '최종 합격')) {
    steps.push({ name: '최종 합격', date: null, dateHint: null });
  }

  // ── 접수 스텝에 마감일을 못 박는다 (서버 규칙 ② — 파서가 접수 **기간의 시작일**을
  //    잡는 결함이 실측 1건 있었다: 한도병원 6/22, 실제 마감 7/5)
  // 🔴 「서류전형 9/2 10:00 → …」처럼 첫 단계가 **서류류인데 이름에 「접수」가 없으면**
  //    파서가 접수 시작일을 그 단계에 붙인다 (스윕 F11 네이버파이낸셜). 그 단계가 곧 접수다 —
  //    아래에서 「서류 접수」를 하나 더 끼우면 서류 단계가 두 줄이 된다. 첫 단계가 서류류이고
  //    발표·합격이 아니면 접수 스텝으로 본다 (이름은 원문 유지, 날짜만 마감으로).
  const namedIntake = steps.findIndex((s) => s.name === '서류 접수');
  const docFirst =
    namedIntake < 0 &&
    steps.length > 0 &&
    /^서류/.test(steps[0].name) &&
    !/발표|합격|결과/.test(steps[0].name);
  const intakeIdx = namedIntake >= 0 ? namedIntake : docFirst ? 0 : -1;
  if (deadlineIso) {
    if (intakeIdx >= 0) {
      steps[intakeIdx].date = deadlineIso;
      steps[intakeIdx].dateHint = cleanDateHint(
        steps[intakeIdx].dateHint ?? deadlineHint,
        deadlineIso,
      );
    } else if (!steps.some((s) => s.date === deadlineIso)) {
      // 접수 스텝이 없는 공고 — 마감을 담을 자리를 만들어 준다.
      // (기존 `create()` 의 「deadline → 첫 스텝 scheduled_date」 관례와 같고,
      //  보드의 D-day 가 첫 스텝 날짜를 읽으므로 여기 없으면 마감이 화면에서 사라진다)
      //
      // 🔴 **이미 마감과 같은 날짜를 든 스텝이 있으면 만들지 않는다.** 실측 코레일은
      //    절차가 「서류전형 3/11 → …」로 시작한다 — 그 스텝이 곧 접수다. 그런데도
      //    앞에 하나 더 끼우면 같은 날짜가 두 줄로 보인다.
      steps.unshift({
        name: '서류 접수',
        date: deadlineIso,
        dateHint: cleanDateHint(deadlineHint, deadlineIso),
      });
    }
  }

  // ── 상한: 전형 9 + 최종 합격 1 = 10. 초과분은 **버리지 않고** 일정으로 (정정 11 —
  //    「날짜를 화면 사정으로 버리고 있었다」). 날짜가 없으면 그대로 잘라낸다.
  const finalPos = steps.findIndex((s) => s.name === '최종 합격');
  const finalStep = finalPos >= 0 ? steps.splice(finalPos, 1)[0] : null;
  if (steps.length > STEP_CAP - 1) {
    const overflow = steps.splice(STEP_CAP - 1);
    for (const s of overflow) {
      if (!s.date) continue;
      const { date, time } = splitIso(s.date);
      extraDates.push({ label: s.name, date, time });
    }
  }
  if (finalStep) steps.push(finalStep);

  // ── 동명 스텝 번호 (서버 규칙 ⑬) — 「면접」이 둘이면 화면에서 구분이 안 된다
  const seen = new Map<string, number>();
  for (const s of steps) {
    const n = (seen.get(s.name) ?? 0) + 1;
    seen.set(s.name, n);
    if (n > 1) s.name = `${s.name} ${n}`.slice(0, MAX_NAME_LEN);
  }

  // ── 날짜순 정렬 + 역전 감지 (서버 규칙 ⑩). 「최종 합격」은 자리를 지킨다.
  const tail = steps.length - 1;
  const positions: number[] = [];
  for (let i = 0; i < tail; i++) if (steps[i].date) positions.push(i);
  const movable = positions.map((i) => steps[i]);
  const sorted = [...movable].sort(
    (a, b) => (isoMs(a.date) ?? 0) - (isoMs(b.date) ?? 0),
  );
  let orderConflict = sorted.some((s, k) => s !== movable[k]);
  positions.forEach((pos, k) => {
    steps[pos] = sorted[k];
  });
  // 최종 합격이 앞 단계보다 이르면 그건 사람이 봐야 한다 (자동으로 옮기지 않는다)
  const lastDated = sorted.length
    ? isoMs(sorted[sorted.length - 1].date)
    : null;
  const finalMs = steps.length ? isoMs(steps[steps.length - 1].date) : null;
  if (lastDated !== null && finalMs !== null && finalMs < lastDated) {
    orderConflict = true;
  }

  return { steps, extraDates, orderConflict };
}

// ────────────────────────────────────────────────────────────────────────
// draft 조립
// ────────────────────────────────────────────────────────────────────────

function cleanArray(arr: string[], maxLen: number): string[] {
  return arr
    .map((s) => s.trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, 50);
}

export interface BuildDraftInput {
  out: CardLlmOutput;
  todayKst: string;
  jobContext: string | null;
  profileJobTitle: string | null;
  /** 보완 질문(회사명)으로 사용자가 직접 적은 값 */
  typedCompanyName?: string | null;
}

/**
 * LLM 출력 + 서버 규칙 → `CardDraft`.
 *
 * 🔴 `notPosting` 이면 **나머지를 전부 버린다** (서버 규칙 ⑤). 실측에서 일기 텍스트에
 * `deadline 9/15` 가 남아 오는 일이 있었다 — 모델을 믿고 부분 채택하면 그 값이 카드에 박힌다.
 */
export function buildDraft(input: BuildDraftInput): CardDraft {
  const { out, todayKst, jobContext, profileJobTitle } = input;

  const emptyDraft: CardDraft = {
    companyName: null,
    jobTitle: null,
    jobTitles: [],
    nearProfile: [],
    jobPicked: null,
    companySource: 'parsed',
    deadline: null,
    deadlineKind: 'unknown',
    jobUrl: null,
    steps: [],
    extraDates: [],
    jobPosting: null,
    orderConflict: false,
    postingYear: null,
    notPosting: true,
    filled: [],
  };
  if (out.notPosting) return emptyDraft;

  // 날짜는 **한 체인**으로 푼다 — 마감이 먼저고 전형이 뒤라는 순서 자체가 앵커의 근거다
  const chain: (ParsedDateObj | null)[] = [
    out.deadline,
    ...out.steps.map((s) => s.date),
  ];
  const resolved = resolveDateChain(chain, out.postingYear, todayKst);
  const deadlineIso = resolved[0];
  const stepDates = resolved.slice(1);

  const built = buildSteps(out.steps, stepDates, deadlineIso, null);

  const typed = input.typedCompanyName?.trim();
  const parsedCompany = out.companyName
    ? stripCompanyAffix(out.companyName).slice(0, MAX_COMPANY_LEN)
    : null;
  const companyName = typed
    ? stripCompanyAffix(typed).slice(0, MAX_COMPANY_LEN) || null
    : parsedCompany || null;

  const job = resolveJob(out.jobTitles, jobContext, profileJobTitle);

  const jp = {
    responsibilities: out.responsibilities.trim().slice(0, 2000) || null,
    requirements: cleanArray(out.requirements, 500),
    preferred: cleanArray(out.preferred, 500),
    techStack: cleanArray(out.techStack, 200),
    qualifications: cleanArray(out.qualifications, 300),
    keywords: cleanArray(out.keywords, 100),
  };
  // 요건이 하나도 없으면 저장하지 않는다 (CEO 결정 5) — 그래야 자소서 배너가
  // 「정리하기」를 제안한다. 빈 껍데기를 넣으면 「정리됨」으로 보여 제안이 사라진다
  const hasPosting =
    jp.responsibilities !== null ||
    jp.requirements.length > 0 ||
    jp.preferred.length > 0 ||
    jp.techStack.length > 0 ||
    jp.qualifications.length > 0 ||
    jp.keywords.length > 0;

  const filled: string[] = [];
  // 🔴 `filled` 는 「**AI 가** 채운 칸」이다. 사람이 적어 넣은 회사명을 여기 넣으면
  //    「AI 값 수정률」의 분모가 부풀어 지표가 실제보다 좋아 보인다.
  if (companyName && !typed) filled.push('companyName');
  if (job.jobTitle) filled.push('jobTitle');
  if (deadlineIso) filled.push('deadline');
  if (built.steps.length > 0) filled.push('steps');
  if (built.extraDates.length > 0) filled.push('extraDates');
  if (hasPosting) filled.push('jobPosting');

  return {
    companyName,
    jobTitle: job.jobTitle,
    // 보완 질문 후보 — 확정됐으면 빈 배열 (프론트가 「고를 게 남았나」를 길이로 본다)
    jobTitles: job.candidates,
    nearProfile: job.nearProfile,
    jobPicked: job.picked,
    companySource: typed ? 'typed' : 'parsed',
    deadline: deadlineIso,
    deadlineKind: out.deadlineKind,
    jobUrl: out.jobUrl,
    steps: built.steps,
    extraDates: built.extraDates,
    jobPosting: hasPosting ? jp : null,
    orderConflict: built.orderConflict,
    postingYear: out.postingYear,
    notPosting: false,
    filled,
  };
}

/**
 * 보관소(Redis·메모리)에서 되읽은 초안 → `CardDraft`.
 *
 * 우리가 직렬화한 값이지만 **되읽는 곳도 신뢰 경계로 취급한다** — 배포 사이에 형태가
 * 바뀌면 옛 JSON 이 남아 있고(`as` 였다면 그게 그대로 카드가 된다), Redis 는 우리 프로세스
 * 밖의 저장소다. 모양이 안 맞으면 null 을 돌려 「초안 만료」와 같은 길로 보낸다.
 */
export function normalizeStoredDraft(raw: unknown): CardDraft | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return null;
  const o = asRecord(raw);
  const kindRaw = o.deadlineKind;
  const deadlineKind: PostingDeadlineKind =
    kindRaw === 'fixed' || kindRaw === 'rolling' || kindRaw === 'unknown'
      ? kindRaw
      : 'unknown';
  const pickedRaw = o.jobPicked;
  const jobPicked: PostingJobPicked | null =
    pickedRaw === 'profile' ||
    pickedRaw === 'single' ||
    pickedRaw === 'chosen' ||
    pickedRaw === 'typed'
      ? pickedRaw
      : null;

  const steps: DraftStep[] = (Array.isArray(o.steps) ? o.steps : [])
    .map((s): DraftStep | null => {
      const so = asRecord(s);
      const name = asStringOrNull(so.name);
      if (!name) return null;
      return {
        name,
        date: asStringOrNull(so.date),
        dateHint: asStringOrNull(so.dateHint),
      };
    })
    .filter((s): s is DraftStep => s !== null);

  const extraDates: DraftExtraDate[] = (
    Array.isArray(o.extraDates) ? o.extraDates : []
  )
    .map((e): DraftExtraDate | null => {
      const eo = asRecord(e);
      const label = asStringOrNull(eo.label);
      const date = asStringOrNull(eo.date);
      if (!label || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      return { label, date, time: normalizeTime(eo.time) };
    })
    .filter((e): e is DraftExtraDate => e !== null);

  const jpRaw = o.jobPosting;
  const jobPosting =
    typeof jpRaw === 'object' && jpRaw !== null && !Array.isArray(jpRaw)
      ? (() => {
          const j = asRecord(jpRaw);
          return {
            responsibilities: asStringOrNull(j.responsibilities),
            requirements: asStringArray(j.requirements),
            preferred: asStringArray(j.preferred),
            techStack: asStringArray(j.techStack),
            qualifications: asStringArray(j.qualifications),
            keywords: asStringArray(j.keywords),
          };
        })()
      : null;

  return {
    companyName: asStringOrNull(o.companyName),
    jobTitle: asStringOrNull(o.jobTitle),
    jobTitles: asStringArray(o.jobTitles),
    nearProfile: asStringArray(o.nearProfile),
    jobPicked,
    companySource: o.companySource === 'typed' ? 'typed' : 'parsed',
    deadline: asStringOrNull(o.deadline),
    deadlineKind,
    jobUrl: sanitizeJobUrl(o.jobUrl),
    steps,
    extraDates,
    jobPosting,
    orderConflict: o.orderConflict === true,
    postingYear: asIntOrNull(o.postingYear),
    notPosting: o.notPosting === true,
    filled: asStringArray(o.filled),
  };
}
