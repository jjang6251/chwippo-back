/**
 * 회사 조사 seed 검증 — CLI 게이트와 부팅 적재가 **같은 규칙**을 공유한다.
 *
 * **왜 두 곳에서 보나** (2026-08-03)
 * 런북에 검수 규칙이 다 적혀 있는데도 **사람이 매번 손으로** 돌리는 구조라, §5 에
 * "임원 이름 금지" 가 **있었는데도** v2026-07 에 **실명 15건이 그대로 유입**됐다.
 * 그래서 CLI 게이트(`npm run verify:seed`)를 만들었는데 — 그것도 **사람이 기억해야
 * 돌아간다.** 한 단계 위에서 같은 문제다. 그래서 서버 적재 시점에도 본다.
 *
 * **두 게이트의 강도는 다르다.**
 *
 * | | 로더(부팅) | CLI |
 * |---|---|---|
 * | 개인정보 · 금지 소스 | ✅ | ✅ |
 * | 필드가 **있는데 타입이 틀림** | ✅ | ✅ |
 * | 필드 **누락** · 키워드 개수 · enum | ❌ | ✅ |
 *
 * 로더는 **안전 백스톱**이지 품질 게이트가 아니다. 완비성까지 막으면 사소한 스키마
 * 진화 하나에 **정상 데이터 전체가 안 들어가는** 더 나쁜 실패가 된다. 반대로 개인정보와
 * 크래시 유발 타입은 **사용자에게 도달하면 되돌릴 수 없어** 백스톱이 필요하다
 * (⚠️ 2026-07-08 `recentTrends` 배열 유입 → 프론트 `.trim()` 크래시가 실제로 도달했다).
 */

// ── 금지 소스 (런북 §2 에서 승격) ─────────────────────────────
interface BlockedSource {
  domain: string;
  reason: string;
  /**
   * 본문 **언급** 탐지용 별칭. `catch`·`indeed`·`blind`·`wanted` 같은 **일반 영단어와
   * `블라인드`(=블라인드 채용) 는 넣지 않는다** — 실측에서 전부 오탐이었다.
   * 비우면 출처 도메인으로만 본다.
   */
  bodyAliases: string[];
}

/**
 * 취업포털·후기 = 판례 리스크(잡코리아 v 사람인 계열) + 방침상 차단.
 * 나무위키 = CC BY-NC-SA(비영리)라 상업 서비스에 쓸 수 없다.
 */
export const BLOCKED_SOURCES: BlockedSource[] = [
  {
    domain: 'jobkorea.co.kr',
    reason: '취업포털·후기',
    bodyAliases: ['jobkorea', '잡코리아'],
  },
  {
    domain: 'saramin.co.kr',
    reason: '취업포털·후기',
    bodyAliases: ['saramin', '사람인'],
  },
  {
    domain: 'jasoseol.com',
    reason: '취업포털·후기',
    bodyAliases: ['jasoseol', '자소설'],
  },
  {
    domain: 'incruit.com',
    reason: '취업포털·후기',
    bodyAliases: ['incruit', '인크루트'],
  },
  {
    domain: 'jobplanet.co.kr',
    reason: '취업포털·후기',
    bodyAliases: ['jobplanet', '잡플래닛'],
  },
  {
    domain: 'linkareer.com',
    reason: '취업포털·후기',
    bodyAliases: ['linkareer', '링커리어'],
  },
  {
    domain: 'rocketpunch.com',
    reason: '취업포털·후기',
    bodyAliases: ['rocketpunch', '로켓펀치'],
  },
  {
    domain: 'kreditjob.com',
    reason: '취업포털·후기',
    bodyAliases: ['kreditjob', '크레딧잡'],
  },
  {
    domain: 'glassdoor.com',
    reason: '취업포털·후기',
    bodyAliases: ['glassdoor', '글래스도어'],
  },
  {
    domain: 'comento.kr',
    reason: '취업포털·후기',
    bodyAliases: ['comento', '코멘토'],
  },
  // 아래 5개는 별칭이 일반어라 **도메인으로만** 본다
  {
    domain: 'teamblind.com',
    reason: '취업포털·후기',
    bodyAliases: ['teamblind'],
  },
  { domain: 'blind.com', reason: '취업포털·후기', bodyAliases: [] },
  {
    domain: 'catch.co.kr',
    reason: '취업포털·후기',
    bodyAliases: ['catch.co.kr'],
  },
  {
    domain: 'wanted.co.kr',
    reason: '취업포털·후기',
    bodyAliases: ['wanted.co.kr'],
  },
  {
    domain: 'indeed.com',
    reason: '취업포털·후기',
    bodyAliases: ['indeed.com'],
  },
  {
    domain: 'namu.wiki',
    reason: '라이선스 충돌(CC BY-NC-SA 비영리)',
    bodyAliases: ['namu.wiki', '나무위키'],
  },
];

/** 금지는 아니지만 **저작자 표시 의무**가 있는 소스 (CC BY-SA). 카운트해서 알려준다 */
export const ATTRIBUTION_REQUIRED = ['wikipedia.org'];

// ── PII 패턴 ────────────────────────────────────────────────
/**
 * 🔴 개인정보처리방침이 "임원 이름·연락처 등 개인 식별 정보 절대 수집·저장 안 함" 을
 * 명시적으로 약속하고 있다. 지키는 절차가 없으면 우리가 우리 약속을 어기는 것이다.
 */
const PII_PATTERNS: Array<[string, RegExp]> = [
  ['이메일', /[\w.+-]+@[\w-]+\.[\w.]+/g],
  ['전화번호', /0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}/g],
  ['주민번호 형태', /\d{6}\s?-\s?[1-4]\d{6}/g],
];

/** 직함 앞 2~3자를 후보로 잡는다. 뒤에 조사(`회장은`·`사장이`)가 붙는 게 정상이라 후행 경계는 두지 않는다 */
const TITLE_RE =
  /(?<![가-힣])([가-힣]{2,3})\s?(회장|대표이사|부회장|사장|CEO|창업자|사외이사)/g;

/**
 * 직함 앞에 오지만 **이름이 아닌** 말들. 이걸 안 거르면 `명예회장`·`신임 대표이사`·
 * `그룹 회장` 이 전부 위반으로 뜬다.
 *
 * 🔴 오탐을 방치하면 안 되는 이유 — "또 오탐이네" 하고 넘기기 시작하면 **진짜 위반도 같이
 * 넘어간다.** 검증 도구의 신뢰도가 곧 탐지율이다.
 */
const NOT_A_NAME = new Set([
  '명예',
  '신임',
  '전임',
  '초대',
  '현직',
  '차기',
  '전직',
  '역대',
  '그룹',
  '지주',
  '금융',
  '계열',
  '모기업',
  '자회사',
  '해당',
  '당사',
  '기술',
  '건설',
  '전자',
  '화학',
  '중공',
  '제철',
  '카드',
  '증권',
  '은행',
  '통신',
  '항공',
  '해운',
  '유통',
  '식품',
  '제약',
  '바이오',
  '에너지',
]);

/** 실명 + 직함 탐지 — 정규식만으로는 오탐이 남아 코드로 한 번 더 거른다 */
export function findExecutiveNames(body: string): string[] {
  const hits = new Set<string>();
  for (const m of body.matchAll(TITLE_RE)) {
    const [full, cand] = m;
    if (NOT_A_NAME.has(cand)) continue;
    // 조사로 끝나면 이름이 아니다 (`불굴의 창업자` → "불굴의")
    if (/[의를은는이가와과로]$/.test(cand)) continue;
    hits.add(full.trim());
  }
  return [...hits];
}

// ── 스키마 ──────────────────────────────────────────────────
/** 배열·객체로 들어오면 프론트 `.trim()` 이 크래시한다 (⚠️ 2026-07-08 실사고) */
const STRING_FIELDS = [
  'businessSummary',
  'coreValues',
  'visionMission',
  'recentTrends',
  'financials',
  'competitors',
  'differentiators',
  'jobInsights',
];
const ARRAY_FIELDS = ['interviewKeywords', 'talentProfile'];
const OBJECT_FIELDS = ['companyProfile', 'productsAndTech'];
const KEYWORD_CATEGORIES = ['tech', 'talent', 'business', 'role', 'issue'];

export interface Violation {
  company: string;
  kind: string;
  detail: string;
}

export interface SeedCompany {
  companyName?: string;
  research?: Record<string, unknown>;
  sources?: unknown[];
}

function domainOf(src: unknown): string {
  const url =
    typeof src === 'string' ? src : ((src as { url?: string })?.url ?? '');
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * 🔴 **안전 검사 — 로더와 CLI 양쪽이 쓴다.**
 *
 * 여기 걸리는 건 "사용자에게 도달하면 되돌릴 수 없는 것" 뿐이다:
 * 개인정보 · 금지 소스 · 크래시 유발 타입. 필드 누락 같은 **완비성은 여기 넣지 않는다**
 * (→ `checkCompleteness`). 백스톱이 품질 문제로 정상 데이터를 막으면 더 나쁜 실패다.
 */
export function checkSafety(entry: SeedCompany): Violation[] {
  const out: Violation[] = [];
  const name = entry.companyName ?? '(이름 없음)';
  const add = (kind: string, detail: string) =>
    out.push({ company: name, kind, detail });

  const r = entry.research;
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    add('스키마', 'research 객체 없음');
    return out;
  }

  // 1) 필드가 **있는데** 타입이 틀린 경우만 — 누락은 완비성 문제라 여기서 안 본다
  for (const f of STRING_FIELDS) {
    if (r[f] !== undefined && typeof r[f] !== 'string')
      add(
        '타입',
        `${f} 가 string 이 아님 (${typeof r[f]}) — 프론트 .trim() 크래시`,
      );
  }
  for (const f of ARRAY_FIELDS) {
    if (r[f] !== undefined && !Array.isArray(r[f]))
      add('타입', `${f} 가 배열이 아님`);
  }
  for (const f of OBJECT_FIELDS) {
    if (
      r[f] !== undefined &&
      (typeof r[f] !== 'object' || r[f] === null || Array.isArray(r[f]))
    )
      add('타입', `${f} 가 객체가 아님`);
  }

  // 2) 금지 소스 — 출처 도메인으로만 판정한다 (본문 언급은 notice, 아래 참조)
  for (const s of entry.sources ?? []) {
    const d = domainOf(s);
    if (!d) {
      add('출처', `URL 파싱 불가: ${JSON.stringify(s).slice(0, 60)}`);
      continue;
    }
    const blocked = BLOCKED_SOURCES.find((b) => d.endsWith(b.domain));
    if (blocked) add('🔴 금지소스', `${blocked.reason}: ${d}`);
  }

  // 3) 개인정보 — 본문 전체를 대상으로
  const body = JSON.stringify(r);
  for (const [label, re] of PII_PATTERNS) {
    const hits = body.match(new RegExp(re.source, 'g'));
    if (hits)
      add(
        '🔴 개인정보',
        `${label} ${hits.length}건: ${[...new Set(hits)].slice(0, 3).join(' · ')}`,
      );
  }
  const names = findExecutiveNames(body);
  if (names.length)
    add(
      '🔴 개인정보',
      `임원 실명 ${names.length}건: ${names.slice(0, 3).join(' · ')}`,
    );

  return out;
}

/**
 * 완비성 검사 — **CLI 전용.** 조사 결과가 쓸 만한지 보는 품질 게이트다.
 * 여기 걸려도 사용자가 다치지는 않으므로 로더는 이걸 보지 않는다.
 */
export function checkCompleteness(entry: SeedCompany): Violation[] {
  const out: Violation[] = [];
  const name = entry.companyName ?? '(이름 없음)';
  const add = (kind: string, detail: string) =>
    out.push({ company: name, kind, detail });

  if (!entry.companyName) add('스키마', 'companyName 없음');
  const r = entry.research;
  if (!r || typeof r !== 'object') return out; // 안전 검사가 이미 잡았다

  for (const f of [...STRING_FIELDS, ...ARRAY_FIELDS, ...OBJECT_FIELDS]) {
    if (r[f] === undefined) add('스키마', `${f} 누락`);
  }

  const kws = r.interviewKeywords;
  if (Array.isArray(kws)) {
    if (kws.length < 5 || kws.length > 8)
      add('스키마', `interviewKeywords ${kws.length}개 (5~8 이어야 함)`);
    for (const k of kws) {
      const cat = (k as { category?: string })?.category;
      if (!cat || !KEYWORD_CATEGORIES.includes(cat))
        add('스키마', `interviewKeywords category 값 오류: ${String(cat)}`);
    }
  }

  if ((entry.sources ?? []).length === 0) add('출처', 'sources 비어 있음');
  return out;
}

/**
 * 금지 소스의 **본문 언급** — 위반이 아니라 참고.
 *
 * 🔴 여기를 위반으로 올리면 안 된다. 본문 스캔은 "출처로 인용했다" 와
 * "그 회사가 취업포털이다"(원티드랩) · "경쟁사로 언급"(다우기술=사람인HR 모회사) ·
 * "동음이의"(블라인드 채용) 를 **구분할 수 없다**. 실측 7건이 전부 정상이었다.
 * 매번 뜨는 오탐에 익숙해지면 진짜 위반도 같이 넘어간다.
 */
export function findBodyMentions(entry: SeedCompany): Violation[] {
  const body = JSON.stringify(entry.research ?? {});
  const name = entry.companyName ?? '(이름 없음)';
  const out: Violation[] = [];
  for (const b of BLOCKED_SOURCES) {
    const hit = b.bodyAliases.find((a) => body.includes(a));
    if (hit)
      out.push({
        company: name,
        kind: '본문 언급',
        detail: `"${hit}" — 인용인지 사람이 확인 (${b.reason})`,
      });
  }
  return out;
}

/** CLI 전용 — 문서 전체를 안전 + 완비성 양쪽으로 본다 */
export function verifySeedDoc(seed: {
  version?: string;
  ttlDays?: number;
  companies?: unknown[];
}): {
  violations: Violation[];
  notices: Violation[];
  stats: Record<string, number>;
} {
  const violations: Violation[] = [];
  /** 위반이 아니라 **사람이 눈으로 볼 목록**. exit code 에 영향을 주지 않는다 */
  const notices: Violation[] = [];
  const stats: Record<string, number> = {
    회사: 0,
    출처: 0,
    '표시의무(위키)': 0,
  };

  if (!seed.version) {
    violations.push({
      company: '(seed 전체)',
      kind: '버전 누락',
      detail:
        'version 문자열이 없다 — 같은 버전이면 부팅 적재가 조기 skip 된다',
    });
  }
  if (!seed.ttlDays) {
    violations.push({
      company: '(seed 전체)',
      kind: 'TTL 누락',
      detail: 'ttlDays 가 없다 (pre-seed 는 180)',
    });
  }

  for (const raw of seed.companies ?? []) {
    const entry = raw as SeedCompany;
    stats['회사']++;
    stats['출처'] += (entry.sources ?? []).length;
    for (const s of entry.sources ?? []) {
      const d = domainOf(s);
      if (d && ATTRIBUTION_REQUIRED.some((b) => d.endsWith(b)))
        stats['표시의무(위키)']++;
    }
    violations.push(...checkSafety(entry), ...checkCompleteness(entry));
    notices.push(...findBodyMentions(entry));
  }

  return { violations, notices, stats };
}
