import type { ActivityType } from './entities/activity.entity';
import type {
  CoverletterTag,
  LogCategory,
  LogComp,
  QuantValue,
} from './entities/activity-log.entity';

/**
 * mock (plans/activity-journal-mock.html) 의 `autoDetectLog` (라인 4584-4666) 와 1:1.
 * - catKeywords (12 카테고리) · compKeywords (10 역량) 사전 그대로
 * - countKeywordMatches 부정 표현 (안/못/없/미) 5자 lookahead 제외
 * - before-after vs count quant 패턴
 * - #해시태그 추출
 * - TYPE_TO_CL[type] fallback (활동 type 기준)
 */

export interface AutoTagResult {
  cat: LogCategory | null;
  comps: LogComp[];
  quant: QuantValue | null;
  keywords: string[];
  cl: CoverletterTag[];
}

// mock 의 동등 regex — anchor 없음, 5자 lookahead 안에 부정 표현 있으면 제외
const NEGATION_AHEAD =
  /(안\s|안했|안한|못\s|못했|못한|없\s|없었|없음|미\s|미수|x\s)/;

function countKeywordMatches(lower: string, words: string[]): number {
  let total = 0;
  for (const w of words) {
    let idx = lower.indexOf(w);
    while (idx !== -1) {
      const after = lower.slice(idx + w.length, idx + w.length + 5);
      if (!NEGATION_AHEAD.test(after)) {
        total += 1;
        break;
      }
      idx = lower.indexOf(w, idx + 1);
    }
  }
  return total;
}

const CAT_KEYWORDS: Record<LogCategory, string[]> = {
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
    '자격증 공부',
    '독학',
    'course',
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

const QUANT_BEFORE_AFTER =
  /(\d+(?:\.\d+)?)\s*[→\->]+\s*(\d+(?:\.\d+)?)\s*([a-zA-Z가-힣%]+)?/;
const QUANT_COUNT = /(\d+(?:\.\d+)?)\s*(건|회|명|개|시간|일|점|위|회사|차)/;
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
      after: ba[2],
      unit: (ba[3] ?? '').trim(),
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

  return {
    cat: detectCat(lower),
    comps: detectComps(lower),
    quant: detectQuant(safe),
    keywords: extractHashtags(safe),
    cl: fallbackCl,
  };
}
