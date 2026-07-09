import type { ActivityType } from './entities/activity.entity';
import type {
  CoverletterTag,
  LogCategory,
  LogComp,
  QuantValue,
} from './entities/activity-log.entity';

/**
 * 자동 태깅 v2 (activity-redesign 후속).
 * v1 은 mock (활동 일지 시절) 사전 1:1 이식이라 팀/직장 활동 어휘 중심 —
 * 퀵캡처가 취준 일상 전체의 입구가 되면서 실측 탐지율 20% (2026-07-08 검토).
 *
 * v2 변경:
 * - 취준 카테고리 3종 신설: coding_test(코테) · interview(면접) · apply(지원·자소서)
 * - learning 에 어학·자격증·스터디 어휘 확장
 * - quant: 단위 붙은 before-after (`2%→5%`, `300ms → 120ms`) 지원, '차' 오탐 제거(1차 면접),
 *   화살표를 명시 기호로 한정 (`3-4회` 범위 표기 오탐 방지)
 * - 영문 키워드 단어 경계 검사 (spring 의 'pr' → develop 오탐 방지)
 * - 부정 lookahead 5자 → 8자 + '않'·'없이' 추가
 * - cl 내용 기반 규칙 추가 — 활동 미연결(기본함) 기록에도 자소서 소재가 붙게.
 *   TYPE_TO_CL fallback 과 병합.
 */

export interface AutoTagResult {
  cat: LogCategory | null;
  comps: LogComp[];
  quant: QuantValue | null;
  keywords: string[];
  cl: CoverletterTag[];
}

// 8자 lookahead 안에 부정 표현 있으면 해당 키워드 제외
const NEGATION_AHEAD =
  /(안\s|안했|안한|못\s|못했|못한|없\s|없었|없음|없이|않|미\s|미수|x\s)/;
const NEGATION_WINDOW = 8;

// 순수 영문·숫자 키워드는 단어 경계 검사 (한글 키워드는 교착어 특성상 substring 유지)
const ASCII_KEYWORD = /^[a-z0-9:]+$/;
const ALNUM = /[a-z0-9]/;

function countKeywordMatches(lower: string, words: string[]): number {
  let total = 0;
  for (const w of words) {
    const needBoundary = ASCII_KEYWORD.test(w);
    let idx = lower.indexOf(w);
    while (idx !== -1) {
      const prev = idx > 0 ? lower[idx - 1] : '';
      const next = lower[idx + w.length] ?? '';
      const boundaryOk =
        !needBoundary || (!ALNUM.test(prev) && !ALNUM.test(next));
      const after = lower.slice(
        idx + w.length,
        idx + w.length + NEGATION_WINDOW,
      );
      if (boundaryOk && !NEGATION_AHEAD.test(after)) {
        total += 1;
        break;
      }
      idx = lower.indexOf(w, idx + 1);
    }
  }
  return total;
}

// 동점 시 정의 순서 우선 — 취준 실전 3종(코테·면접·지원)을 맨 앞에 (취준 문맥 우세)
const CAT_KEYWORDS: Record<LogCategory, string[]> = {
  coding_test: [
    '코테',
    '코딩테스트',
    '코딩 테스트',
    '알고리즘',
    '백준',
    '프로그래머스',
    '릿코드',
    'leetcode',
    '솔브드',
    'solved.ac',
    '그리디',
    '완전탐색',
    '문제 풀',
    '문제를 풀',
    '문제풀',
    '풀이',
  ],
  interview: [
    '면접',
    '꼬리질문',
    '꼬리 질문',
    '기술질문',
    '기술 질문',
    '인성질문',
    '인성 질문',
    '1분 자기소개',
  ],
  apply: [
    '자소서',
    '자기소개서',
    '지원서',
    '이력서',
    '입사지원',
    '지원했',
    '지원 완료',
    '서류',
    '첨삭',
    '공고',
    '원서',
    '포트폴리오 제출',
  ],
  develop: [
    'pr',
    '머지',
    '커밋',
    '코드',
    '리팩터',
    '버그',
    '개발',
    '구현',
    'api',
    '디버깅',
    '배포',
    'deploy',
    '백엔드',
    '프론트',
    '풀스택',
    'devops',
    'ml',
    '머신러닝',
    'code review',
    '코드리뷰',
    '깃허브',
    'github',
    '서버',
    '쿼리',
  ],
  meeting: [
    '회의',
    '미팅',
    '브리핑',
    '주간보고',
    'standup',
    '스탠드업',
    '1on1',
    '1:1',
    '데일리',
  ],
  presentation: [
    '발표',
    '강연',
    '시연',
    '데모',
    '제안',
    '프레젠',
    'pt',
    '컨퍼런스',
    '워크샵',
    '특강',
    '세미나',
  ],
  collaboration: [
    '협업',
    '팀원',
    '함께',
    '같이',
    '페어',
    'pair',
    'slack',
    '디스코드',
    '협력',
  ],
  conflict_resolution: [
    '갈등',
    '조율',
    '풀어',
    '해결',
    '중재',
    '트러블',
    '분쟁',
    '의견 충돌',
    '의견충돌',
  ],
  learning: [
    '배움',
    '학습',
    '읽음',
    '강의',
    '공부',
    '수강',
    '튜토리얼',
    '인강',
    '자격증',
    '독학',
    'course',
    '스터디',
    '토익',
    '오픽',
    'opic',
    '토플',
    '텝스',
    '아이엘츠',
    '어학',
    '영어',
    '단어',
    '정처기',
    '전공',
  ],
  leadership: [
    '리드',
    '운영',
    '관리',
    '주도',
    '주관',
    '리더',
    '회장',
    '회장단',
    'lead',
    'pm',
    '매니징',
    '멘토',
    'mentor',
    '튜터',
  ],
  volunteer: ['봉사', '도움', '기부', '자원봉사', '모금'],
  customer: [
    '고객',
    '손님',
    '클라이언트',
    '응대',
    'cs',
    'b2b',
    'b2c',
    '영업',
    '매출',
    '신규고객',
  ],
  analysis: [
    '분석',
    '리서치',
    '조사',
    '데이터',
    '인터뷰',
    '설문',
    '통계',
    '지표',
    'kpi',
    'roas',
    'ctr',
    '퍼널',
    'ut',
    'ux 리서치',
    '사용자 조사',
    '사용자조사',
    '보고서',
    '인사이트',
  ],
  creative: [
    '기획',
    '디자인',
    '아이디어',
    '콘텐츠',
    '제작',
    '시안',
    '카피',
    '카피라이팅',
    '영상',
    '편집',
    '사진',
    '일러스트',
    '브랜딩',
    '로고',
    '아트워크',
    'wireframe',
    '와이어프레임',
  ],
  other: [],
  rest: [], // activity-redesign — 쉬어가기는 autoTag 미호출이지만 타입 충족용
};

const COMP_KEYWORDS: Record<LogComp, string[]> = {
  technical: [
    '코드',
    'api',
    '개발',
    '기술',
    '구현',
    '리팩터',
    '백엔드',
    '프론트',
    'ml',
    'devops',
    '알고리즘',
    '쿼리',
  ],
  leadership: [
    '리드',
    '주도',
    '운영',
    '관리',
    '회장',
    'lead',
    'pm',
    '매니징',
    '멘토',
    '주관',
  ],
  communication: ['발표', '설명', '소통', '협업', '프레젠', '브리핑', '제안'],
  planning: ['기획', '계획', '제안', '전략', '로드맵', '로드맵핑', '스프린트'],
  analytical: [
    '분석',
    '데이터',
    '리서치',
    '조사',
    '통계',
    '지표',
    'kpi',
    '인사이트',
    'ut',
  ],
  problem_solving: ['해결', '풀어', '개선', '디버깅', '최적화', '트러블'],
  collaboration: ['협업', '팀원', '같이', '함께', '페어', '협력'],
  creativity: [
    '디자인',
    '아이디어',
    '창작',
    '콘텐츠',
    '시안',
    '브랜딩',
    '카피',
    '와이어프레임',
  ],
  responsibility: ['책임', '주관', '담당', '운영', '관리'],
  adaptability: ['적응', '대응', '유연', '변화'],
};

const TYPE_TO_CL: Record<ActivityType, CoverletterTag[]> = {
  intern: ['job_competency'],
  club: ['collaboration', 'background'],
  study: ['job_competency', 'background'],
  project: ['job_competency', 'collaboration'],
  sideproject: ['job_competency', 'challenge'],
  contest: ['challenge', 'job_competency'],
  research: ['job_competency', 'challenge'],
  parttime: ['collaboration', 'background'],
  volunteer: ['background', 'personality'],
  overseas: ['challenge', 'background'],
  bootcamp: ['job_competency', 'background'],
  other: [],
};

// 화살표는 명시 기호만 — '3-4회' 같은 범위 표기를 before-after 로 오탐하지 않게
const QUANT_BEFORE_AFTER =
  /(\d+(?:\.\d+)?)\s*([a-zA-Z가-힣%]{0,4})\s*(?:→|➔|⇒|=>|->|--+>)\s*(\d+(?:\.\d+)?)\s*([a-zA-Z가-힣%]{0,6})/;
// '차' 제거 (1차 면접 = 회차 표현, 성과 아님) · 취준 단위 추가 (문제·문항·솔·%·분·페이지·장)
const QUANT_COUNT =
  /(\d+(?:\.\d+)?)\s*(건|회|명|개|시간|분|일|점|위|회사|문제|문항|솔|페이지|장|%)/;
const HASHTAG = /#[가-힣A-Za-z0-9_]+/g;

function detectCat(lower: string): LogCategory | null {
  let maxScore = 0;
  let chosen: LogCategory | null = null;
  // Object.entries 순서 = 사전 정의 순서 (Node.js 보장)
  for (const [cat, words] of Object.entries(CAT_KEYWORDS) as Array<
    [LogCategory, string[]]
  >) {
    if (words.length === 0) continue;
    const score = countKeywordMatches(lower, words);
    if (score > maxScore) {
      maxScore = score;
      chosen = cat;
    }
  }
  return chosen;
}

function detectComps(lower: string): LogComp[] {
  const scored: Array<[LogComp, number]> = [];
  for (const [comp, words] of Object.entries(COMP_KEYWORDS) as Array<
    [LogComp, string[]]
  >) {
    const score = countKeywordMatches(lower, words);
    if (score > 0) scored.push([comp, score]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, 3).map(([c]) => c);
}

function detectQuant(content: string): QuantValue | null {
  const ba = content.match(QUANT_BEFORE_AFTER);
  if (ba) {
    return {
      type: 'before-after',
      before: ba[1],
      after: ba[3],
      // 뒤 단위 우선, 없으면 앞 단위 (`2%→5%` 는 둘 다 % — 뒤 캡처 사용)
      unit: (ba[4] || ba[2] || '').trim(),
    };
  }
  const cnt = content.match(QUANT_COUNT);
  if (cnt) {
    return { type: 'count', value: cnt[1], unit: cnt[2], metric: '' };
  }
  return null;
}

function extractHashtags(content: string): string[] {
  const m = content.match(HASHTAG);
  return m ? m.map((h) => h.slice(1)) : [];
}

// 고정밀 내용 기반 자소서 소재 (v2) — 기본함(활동 미연결) 기록에도 소재가 붙는 유일한 경로
const CHALLENGE_PATTERN =
  /(실패|탈락|도전|극복|재도전|다시 도전|처음 해|처음으로|어려웠)/;
const JOB_COMPETENCY_CATS: ReadonlySet<LogCategory> = new Set([
  'develop',
  'analysis',
  'creative',
]);

function detectClFromContent(
  lower: string,
  cat: LogCategory | null,
  comps: LogComp[],
): CoverletterTag[] {
  const cl: CoverletterTag[] = [];
  if (CHALLENGE_PATTERN.test(lower)) cl.push('challenge');
  if (
    cat === 'collaboration' ||
    cat === 'conflict_resolution' ||
    comps.includes('collaboration')
  ) {
    cl.push('collaboration');
  }
  if (
    (cat && JOB_COMPETENCY_CATS.has(cat)) ||
    comps.includes('technical') ||
    comps.includes('analytical')
  ) {
    cl.push('job_competency');
  }
  return cl;
}

export function autoTag(
  content: string,
  activityType: ActivityType | null | undefined,
): AutoTagResult {
  const safe = content ?? '';
  const lower = safe.toLowerCase();
  const fallbackCl = activityType ? (TYPE_TO_CL[activityType] ?? []) : [];

  if (safe.trim().length === 0) {
    return {
      cat: null,
      comps: [],
      quant: null,
      keywords: [],
      cl: fallbackCl,
    };
  }

  const cat = detectCat(lower);
  const comps = detectComps(lower);
  const contentCl = detectClFromContent(lower, cat, comps);
  // 내용 기반 우선 + type fallback 병합, 최대 3개
  const cl = [...new Set([...contentCl, ...fallbackCl])].slice(0, 3);

  return {
    cat,
    comps,
    quant: detectQuant(safe),
    keywords: extractHashtags(safe),
    cl,
  };
}
