/**
 * 회사명 실존 판정 · 유사명 제안 (feature-research-moment, 2026-08-22).
 *
 * ops 「회사 조사 현황」 표에서 **「까까오」(오타)** 와 **「한솔로지스틱스」(실존 비상장)**
 * 를 가르기 위한 순수 함수 모음. 지금은 둘이 똑같이 보여서 조사 배치를 돌릴 때
 * 오타를 조사 대상으로 착각한다.
 *
 * 🔴 거리는 **글자가 아니라 자모** 로 잰다. 「까까오」→「카카오」 는 글자 단위로는 2칸
 *    (거의 다른 이름)이지만 자모로는 ㄲ→ㅋ 두 번(2/6)이다. 한국어 오타는 자모 단위로
 *    일어나므로(된소리·모음 오타) 글자 단위 편집거리는 오타를 통째로 놓친다.
 *
 * 구조:
 * - `normalized` Set → 실존 여부 O(1)
 * - `byLength` Map(글자 길이) → 편집거리 후보를 ±2 글자로 좁힘
 *
 * ⚠️ 인덱스는 **요청당 1회** 만들고 행마다 재사용한다. companies.json 은 3,798개라
 *    행마다 전수 비교하면 admin 표 한 페이지(최대 100행)에 38만 회 비교가 된다.
 */

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = 'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';
const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;

/**
 * 후보 길이 창(글자) — 자모 거리 최대 4는 글자로 환산하면 2글자 안팎이다
 * (한 글자 = 자모 2~3개). ±2 글자면 놓치는 후보 없이 후보군을 크게 줄인다.
 */
const CANDIDATE_LENGTH_WINDOW = 2;

interface IndexedName {
  /** companies.json 원본 표기 — 제안 문구에 그대로 쓴다 */
  display: string;
  norm: string;
  /** 인덱싱 시 1회만 분해 — 행마다 다시 쪼개지 않는다 */
  jamo: string;
}

export interface CompanyNameIndex {
  /** 정규화 이름 집합 — 실존 여부 판정 */
  normalized: Set<string>;
  /** 글자 길이 → 후보 목록. 편집거리 계산 대상을 좁히는 용도 */
  byLength: Map<number, IndexedName[]>;
}

/** 정규화 — 조사 캐시·지원 카드 병합 키와 동일 규칙 (lowercase + trim). */
export function normalizeCompanyName(s: string): string {
  return s.trim().toLowerCase();
}

/** 한글 음절 → 초·중·종성 분해. 한글이 아닌 문자는 그대로 통과. */
export function toJamo(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < HANGUL_BASE || code > HANGUL_LAST) {
      out += ch;
      continue;
    }
    const offset = code - HANGUL_BASE;
    out += CHO[Math.floor(offset / 588)];
    out += JUNG[Math.floor((offset % 588) / 28)];
    const jong = offset % 28;
    if (jong > 0) out += JONG[jong - 1];
  }
  return out;
}

/**
 * 자모 길이별 허용 편집거리.
 * 짧은 이름일수록 한 자모의 무게가 크지만, 「까까오」(6자모)가 2 를 필요로 해서
 * 하한이 2 다. 대신 **글자 길이 3 미만은 아예 제안하지 않는다**(아래 참조) —
 * 「토스」↔「포스」처럼 진짜 다른 회사가 걸리는 구간을 그쪽에서 막는다.
 */
function maxJamoDistance(len: number): number {
  if (len <= 12) return 2;
  if (len <= 20) return 3;
  return 4;
}

export function buildCompanyNameIndex(names: string[]): CompanyNameIndex {
  const normalized = new Set<string>();
  const byLength = new Map<number, IndexedName[]>();
  for (const display of names) {
    const norm = normalizeCompanyName(display);
    if (norm.length === 0) continue;
    normalized.add(norm);
    const entry: IndexedName = { display, norm, jamo: toJamo(norm) };
    const bucket = byLength.get(norm.length);
    if (bucket) bucket.push(entry);
    else byLength.set(norm.length, [entry]);
  }
  return { normalized, byLength };
}

/** companies.json(DART) 목록에 이 이름이 있는가. */
export function hasCompanyName(name: string, index: CompanyNameIndex): boolean {
  return index.normalized.has(normalizeCompanyName(name));
}

/**
 * 편집거리 — `max` 를 넘는 순간 `null` (조기 중단).
 * 행 최소값이 이미 max 를 넘으면 이후 행에서 더 줄지 않으므로 그 자리에서 끊는다.
 */
function levenshteinWithin(a: string, b: string, max: number): number | null {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > max) return null;

  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  let curr = new Array<number>(m + 1);
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return null;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[m] <= max ? prev[m] : null;
}

/**
 * 가장 가까운 실존 이름 1개. 없거나 명백히 멀면 `null`.
 *
 * 🔴 **실존하는 이름이면 계산하지 않는다** — 제안이 필요 없는 행이고, 그게 곧
 *    가장 흔한 경로다(조사된 회사 대부분은 companies.json 안에 있다).
 * 🔴 **2글자 이하는 제안하지 않는다** — 「토스」↔「포스」, 「SK」↔「SC」 처럼 한 자만
 *    달라도 완전히 다른 회사다. 엉뚱한 제안은 없느니만 못하다.
 * 동점이면 원본 표기 사전순으로 고정 — 같은 입력에 항상 같은 제안이 나와야 한다.
 */
export function findSimilarCompanyName(
  name: string,
  index: CompanyNameIndex,
): string | null {
  const q = normalizeCompanyName(name);
  if (q.length < 3) return null;
  if (index.normalized.has(q)) return null;

  const qJamo = toJamo(q);
  const max = maxJamoDistance(qJamo.length);
  let best: { display: string; dist: number } | null = null;
  for (
    let len = q.length - CANDIDATE_LENGTH_WINDOW;
    len <= q.length + CANDIDATE_LENGTH_WINDOW;
    len++
  ) {
    for (const cand of index.byLength.get(len) ?? []) {
      const dist = levenshteinWithin(qJamo, cand.jamo, max);
      if (dist === null) continue;
      if (
        best === null ||
        dist < best.dist ||
        (dist === best.dist && cand.display.localeCompare(best.display) < 0)
      ) {
        best = { display: cand.display, dist };
      }
    }
  }
  return best?.display ?? null;
}
