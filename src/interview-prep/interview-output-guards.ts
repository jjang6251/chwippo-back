/**
 * 면접 AI 출력 후처리 검증 (2026-08-07).
 *
 * ## 왜 프롬프트가 아니라 코드인가
 *
 * 같은 문제를 프롬프트 지시로 **두 번 고쳤는데 두 번 다 실패했다.**
 *
 * - 로그 오귀속 — "답변에 그 로그의 내용이 실제로 등장해야 단다" 를 넣었더니, 프롬프트에
 *   **실명으로 인용한 짝**(장애 질문↔코드리뷰 로그)만 사라지고 **다른 로그로 옮겨갔다**.
 *   수정 전 2~3건 → 수정 후 4건으로 오히려 늘었다.
 * - 자료 밖 고유명사 — "지어내지 마라" 를 세 번 강화했는데, 가정형이던 MySQL 질문이
 *   **단정형 + 최우선 준비**로 승격됐다.
 *
 * 두 축 다 **셀 수 있는 것**이다. 셀 수 있는 것을 확률적 장치에 맡기면 검증도 확률이 된다.
 *
 * ## 실패 방향은 "덜 주장한다" 쪽으로
 *
 * 오탐이 나면 근거 표시가 사라지거나 질문 하나가 빠진다 — 사용자는 **덜 본다.**
 * 미탐이 나면 사용자가 자기 기록을 못 믿게 되거나, 안 한 일을 했다고 준비한다.
 * 두 손해의 크기가 다르므로 애매하면 떼는 쪽으로 판정한다.
 */

/** 내용 대조에 쓸 토큰 — 2자 이상 한글/영숫자 */
function contentTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^가-힣a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2),
  );
}

/**
 * 🔴 **한국어는 조사가 뒤에 붙는다** — 완전 일치로 보면 `프로토타입` 과 `프로토타입을`,
 * `리포트` 와 `리포트를` 이 서로 다른 토큰이 된다. B 세트 실측에서 **토큰 대조 999건 중
 * 96건(9.6%)** 이 이 이유로 어긋났고, 그 결과 ⓐ 채점기가 정당한 참조를 오귀속으로 잡고
 * ⓑ 런타임 필터가 정당한 참조를 뗐다.
 *
 * 형태소 분석기를 붙이지 않고 **접두 일치**로 푼다 — 조사는 접미이므로 방향이 맞고,
 * 의존성 없이 대부분을 덮는다. 양방향으로 보는 이유는 로그 쪽에도 조사가 붙기 때문이다
 * (로그 `지출을` vs 질문 `지출`).
 *
 * 🔴 **2자 접두는 위험하다** — `사업` 이 `사업자` 를, `개발` 이 `개발자` 를 먹는다.
 * 그래서 접두 일치는 **3자 이상**만 허용하고, 2자는 완전 일치만 인정한다.
 */
const MIN_PREFIX_LEN = 3;

function hasToken(hay: Set<string>, token: string): boolean {
  if (hay.has(token)) return true;
  if (token.length < MIN_PREFIX_LEN) return false;
  for (const w of hay) {
    if (w.startsWith(token)) return true;
    if (w.length >= MIN_PREFIX_LEN && token.startsWith(w)) return true;
  }
  return false;
}

/**
 * 🔴 **각 로그의 "이 로그에만 있는" 토큰.**
 *
 * 그냥 겹침을 세면 `경험`·`진행`·`담당` 같은 말이 어느 로그에나 있어서 **무관한 로그도
 * 통과한다.** 불용어 목록을 손으로 관리하는 대신, 다른 로그에 없는 토큰만 남긴다 —
 * 자료가 바뀌면 기준도 같이 바뀌므로 관리가 필요 없다.
 */
export function distinctiveTokens(logs: string[]): Array<Set<string>> {
  const all = logs.map(contentTokens);
  return all.map((own, i) => {
    const others = new Set<string>();
    all.forEach((s, j) => {
      if (j !== i) s.forEach((t) => others.add(t));
    });
    const only = new Set<string>();
    own.forEach((t) => {
      if (!others.has(t)) only.add(t);
    });
    // 전부 공유되는 로그(거의 같은 내용)는 판정 근거가 없다 → 원본으로 되돌린다.
    // 여기서 빈 집합을 주면 아래 판정이 **무조건 탈락**시켜 정당한 참조까지 날아간다.
    return only.size > 0 ? only : own;
  });
}

export interface AttributionInput {
  /** 생성된 텍스트 (답변 또는 질문) */
  text: string;
  /** 모델이 단 로그 id */
  claimedIds: string[];
  /** 후보 풀 — id 와 본문이 같은 순서로 대응 */
  pool: Array<{ id: string; body: string }>;
}

/**
 * `source_log_ids` **내용 일치 필터.**
 *
 * 기존 코드는 `validIds.has(id)` 로 **id 가 실존하는지만** 봤다. 그래서 "장애 로그가 없어
 * 3시간 헤맸다" 질문에 **코드 리뷰 로그**가 달려도 통과했다 — id 는 진짜였으니까.
 * 화면은 그걸 "이 기록에서 나온 질문" 으로 표시하므로, 틀리면 사용자가 **자기 활동 기록
 * 자체를 못 믿게 된다.**
 *
 * 판정: 그 로그의 고유 토큰이 텍스트에 몇 개 등장하는가.
 *
 * 🔴 **한 개로는 부족하다.** 처음엔 1개로 뒀는데 실측 오귀속이 통과했다 —
 * 로그 `예약 착오 고객 응대` 와 질문 `협업하여 고객 문제를 해결한 경험` 이 `고객`
 * 하나로 이어졌다. 한국어 명사(고객·경험·문제·관리)는 도메인을 넘나들어 **한 단어
 * 일치는 근거가 못 된다.** 그래서 로그가 낼 수 있으면 **2개**를 요구한다.
 *
 * 다만 짧은 로그는 2개를 낼 수 없다. 고유 토큰이 4개 미만이면 1개로 완화한다 —
 * 안 그러면 한 줄짜리 기록만 가진 사용자가 근거 표시를 영영 못 본다.
 *
 * 🔴 **풀이 1개면 무조건 통과시킨다.** 비교 대상이 없어 "이 로그만의 토큰" 자체가
 * 성립하지 않는다.
 */
const MIN_HITS = 2;
/** 이보다 토큰이 적은 로그는 MIN_HITS 를 못 채우므로 1개로 완화 */
const RICH_LOG_TOKENS = 4;
export function filterAttributableLogIds(input: AttributionInput): string[] {
  const { text, claimedIds, pool } = input;
  if (claimedIds.length === 0) return [];
  const byId = new Map(pool.map((p) => [p.id, p.body]));
  const valid = claimedIds.filter((id) => byId.has(id));
  if (pool.length <= 1) return valid;

  const marks = distinctiveTokens(pool.map((p) => p.body));
  const markById = new Map(pool.map((p, i) => [p.id, marks[i]]));
  const hay = contentTokens(text);

  return valid.filter((id) => {
    const own = markById.get(id);
    if (!own || own.size === 0) return true;
    let hits = 0;
    for (const t of own) if (hasToken(hay, t)) hits++;
    const need = own.size >= RICH_LOG_TOKENS ? MIN_HITS : 1;
    return hits >= need;
  });
}

/**
 * **사용자가 했다고 단정하는 어법.**
 *
 * 면접관 시뮬레이터라 "~했다고 했는데" 로 되묻는 게 자연스럽고, 그래서 자료에 없는 일도
 * 같은 어법으로 나온다. 실물:
 *
 * > `MySQL에서 정산 배치 처리 시간을 줄이기 위해 인덱스 2개를 추가했다고 했는데, …`
 *
 * 사용자는 DB 이름을 말한 적이 없다. 이걸 **최우선 준비**로 표시하면 사용자는 거짓 전제를
 * 외워서 면접장에 간다.
 */
const ASSERTION_PATTERNS = [
  /했다고\s*(하셨|했)/,
  /하셨다고\s*(하셨|했)/,
  /경험이\s*있다고\s*(하셨|했)/,
  /사용했다고/,
  /도입했다고/,
];

/**
 * 기술·제품명 후보 추출 — 영문 시작 2자 이상 (한국어 텍스트에서 고유명사는 대개 이 형태다).
 *
 * 🔴 정규식을 상수로 **공유하지 않는다.** `g` 플래그 정규식은 `lastIndex` 를 들고 있어,
 * 같은 객체를 재사용하면 호출 순서에 따라 결과가 달라진다. 매번 새로 만든다.
 */
function techTokens(s: string): string[] {
  return s.match(/[A-Za-z][A-Za-z0-9.+#_]{1,}/g) ?? [];
}

/**
 * 한국어 면접 텍스트에 흔히 섞이는 **기술명이 아닌** 영문. 이걸 안 빼면 오탐이 난다.
 * 목록을 짧게 유지한다 — 길어지면 진짜 위조를 덮는다.
 */
const NON_TECH_ASCII = new Set([
  'ai',
  'it',
  'pt',
  'pr',
  'hr',
  'cs',
  'ux',
  'ui',
  'kpi',
  'star',
  'prep',
  'ok',
  'no',
  'vs',
]);

export interface UnsupportedTechInput {
  /** 생성된 질문·답변 텍스트 */
  text: string;
  /** 사용자가 실제로 낸 자료 전부 (자소서·활동 로그·메모) */
  userMaterial: string;
}

/**
 * **자료에 없는 기술을 "했다" 고 단정했는지** 검출.
 *
 * 두 조건을 **함께** 봐야 한다:
 * - 단정 어법이 있다 → 없으면 "Kafka 경험이 있으신가요" 같은 **정당한 질문**까지 걸린다
 *   (공고 요건을 묻는 건 면접관이 당연히 하는 일이다)
 * - 그 토큰이 사용자 자료에 없다 → 있으면 사용자가 실제로 말한 것이다
 *
 * 공고에 있는지는 **보지 않는다.** 공고에 Kafka 가 있어도 사용자가 안 했으면
 * "했다고 했는데" 는 여전히 거짓이다.
 */
export function findUnsupportedTechAssertions(
  input: UnsupportedTechInput,
): string[] {
  const { text, userMaterial } = input;
  if (!ASSERTION_PATTERNS.some((r) => r.test(text))) return [];

  const known = new Set(techTokens(userMaterial).map((t) => t.toLowerCase()));
  const found = new Set<string>();
  for (const raw of techTokens(text)) {
    const t = raw.toLowerCase();
    if (NON_TECH_ASCII.has(t)) continue;
    if (known.has(t)) continue;
    found.add(raw);
  }
  return [...found];
}

/**
 * 꼬리질문 **재진술 중복** 판정 (2026-08-07 3회차 심사에서 확정).
 *
 * ## 프롬프트 지시가 세 번째로 실패한 자리다
 *
 * 형제 질문 블록에 앞 꼬리질문을 **이미 넣어주고** "표현만 바꾼 재진술도 안 된다" 고
 * 명시했는데도 4o-mini 가 그대로 재생산했다. 실물:
 *
 * > Q1 꼬리 — "배치 크기를 결정할 때 고려한 구체적인 기준은 무엇이었고, 그 기준이 실제로
 * >            성능 개선에 어떻게 기여했는지"
 * > Q21 꼬리 — "배치 크기를 결정할 때 어떤 구체적인 기준을 사용하셨으며, 이 결정이 실제로
 * >            성능 향상에 어떻게 기여했는지"
 *
 * 꼬리질문은 **코인을 쓰는 기능**이라 사용자가 돈을 내고 같은 질문을 두 번 받는다.
 *
 * ## 왜 어절이 아니라 접두 일치인가
 *
 * 위 두 문장은 어절이 거의 다르다 (`기준은`/`기준을`, `기여했는지`는 같지만 `무엇이었고`/
 * `사용하셨으며`). 완전 일치로 세면 중복이 안 잡힌다. `hasToken` 으로 조사를 넘어 본다.
 */
const FOLLOWUP_DUP_RATIO = 0.6;

/**
 * 🔴 **여기선 `hasToken` 보다 느슨하게 본다.** 접두 일치는 조사 *추가*(`기준`→`기준을`)만
 * 잡고 *변형*(`기준은` ↔ `기준을`, `고려한` ↔ `고려하셨는지`)은 못 잡는다. 실측 중복 쌍이
 * 정확히 그 형태라 접두만으로는 통과했다.
 *
 * **어간 2자를 공유하면 같은 말로 본다.** 오귀속 필터에는 이 기준을 못 쓴다 —
 * `사업`/`사업자` 가 붙어 무관한 로그가 살아남기 때문이다. 두 곳의 **실패 비용이 다르다**:
 * 여기서 틀리면 재시도 한 번(0.4원)이고, 저기서 틀리면 사용자가 자기 기록을 못 믿게 된다.
 */
function sharesStem(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i >= 2;
}

export function isDuplicateFollowup(
  candidate: string,
  existing: string[],
): boolean {
  const cand = [...contentTokens(candidate)];
  if (cand.length === 0) return false;
  return existing.some((prev) => {
    const prevTokens = [...contentTokens(prev)];
    if (prevTokens.length === 0) return false;
    const hit = cand.filter((t) =>
      prevTokens.some((p) => sharesStem(t, p)),
    ).length;
    // 분모는 **짧은 쪽** — 긴 질문이 짧은 질문을 통째로 품는 경우를 놓치지 않는다
    return hit / Math.min(cand.length, prevTokens.length) >= FOLLOWUP_DUP_RATIO;
  });
}

/**
 * 공고 요건 **커버리지 측정** (감사 전용 — 런타임에서 막지 않는다).
 *
 * 🔴 프롬프트에 `(공고에 "Kafka·MSA 우대" 가 있으면 그쪽을 묻는다)` 라고 **이름까지 박았는데
 * 질문 20개 중 0건**이었다. 지시를 더 밀 문제가 아니라 세어서 봐야 하는 문제다.
 *
 * 런타임에서 안 막는 이유: 커버리지가 낮다고 **버릴 질문이 없다.** 이건 프롬프트·모델을
 * 고칠 신호이지 사용자에게 보여줄 것을 줄일 근거가 아니다.
 */
export function measureJobPostingCoverage(
  questionTexts: string[],
  requirementLines: string[],
): Array<{ requirement: string; covered: boolean; hitTokens: string[] }> {
  const hay = contentTokens(questionTexts.join(' '));
  return requirementLines.map((requirement) => {
    // 요건 줄에서 **판별력 있는 토큰**만 남긴다 — `경험`·`이해`·`가능` 은 어디에나 있다
    const generic = new Set([
      '경험',
      '이해',
      '가능',
      '능력',
      '업무',
      '관련',
      '기반',
      '활용',
      '작성',
      '개발',
      '운영',
    ]);
    const tokens = [...contentTokens(requirement)].filter(
      (t) => !generic.has(t),
    );
    const hitTokens = tokens.filter((t) => hasToken(hay, t));
    return { requirement, covered: hitTokens.length > 0, hitTokens };
  });
}
