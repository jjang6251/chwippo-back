/**
 * W2 — DART industry → W1 JobCategory boost 매핑.
 *
 * 사용자의 signupJobCategories (관심 직군) 와 회사의 industry 매칭 시
 * 자동완성 dropdown 에서 우선순위 boost.
 *
 * 한국 DART 업종 분류 → W1 JOB_CATEGORIES 21개 매핑.
 * 1 industry → N 직군 가능 (예: IT 회사는 백엔드·프론트·디자인·기획 모두 관련).
 *
 * **부분 매핑** — 모든 industry 망라 X. 매핑 없는 industry = boost 0 (그래도 일반 검색에 포함됨)
 */

import type { JobCategory } from '../users/signup-job-categories.const';

/** industry 키워드 → 매칭되는 JobCategory list */
const INDUSTRY_BOOST_MAP: { keywords: string[]; categories: JobCategory[] }[] =
  [
    // IT · 개발
    {
      keywords: [
        'IT',
        '소프트웨어',
        'SW',
        '게임',
        '인터넷',
        '플랫폼',
        '클라우드',
        '데이터',
      ],
      categories: [
        '백엔드 개발',
        '프론트엔드 개발',
        '모바일 앱 개발',
        '데이터·AI',
        'DevOps·인프라·보안',
        'UI/UX·프로덕트 디자이너',
        '서비스 기획·PM',
      ],
    },
    // 금융 · 증권 · 보험
    {
      keywords: [
        '은행',
        '증권',
        '카드',
        '캐피탈',
        '보험',
        '금융',
        '투자',
        '핀테크',
      ],
      categories: [
        '금융·은행·증권·보험',
        '재무·회계·세무',
        '경영기획·전략·컨설팅',
      ],
    },
    // 의료 · 제약 · 바이오
    {
      keywords: ['제약', '바이오', '의약', '의료', '헬스케어', '병원'],
      categories: ['의료·제약·바이오', 'R&D·연구개발'],
    },
    // 제조 · 자동차 · 화학
    {
      keywords: [
        '자동차',
        '제조',
        '화학',
        '소재',
        '철강',
        '전자',
        '반도체',
        '디스플레이',
        '석유',
        '에너지',
      ],
      categories: [
        '제조·생산·품질·SCM',
        'R&D·연구개발',
        '경영기획·전략·컨설팅',
      ],
    },
    // 건설 · 토목
    {
      keywords: ['건설', '건축', '토목', '엔지니어링', '인프라'],
      categories: ['제조·생산·품질·SCM', '경영기획·전략·컨설팅'],
    },
    // 유통 · 이커머스 · 물류
    {
      keywords: [
        '유통',
        '이커머스',
        '쇼핑',
        '백화점',
        '마트',
        '편의점',
        '물류',
        '운송',
      ],
      categories: [
        '마케팅·광고',
        '영업·세일즈',
        '고객서비스·CS·CX',
        '경영기획·전략·컨설팅',
        '서비스 기획·PM',
      ],
    },
    // 미디어 · 콘텐츠 · 방송
    {
      keywords: [
        '미디어',
        '방송',
        '콘텐츠',
        '언론',
        '신문',
        '출판',
        '엔터테인먼트',
        '음악',
        '영상',
      ],
      categories: [
        '콘텐츠·에디터·PR',
        'UI/UX·프로덕트 디자이너',
        '그래픽·브랜드 디자이너',
        '마케팅·광고',
      ],
    },
    // 통신
    {
      keywords: ['통신', '텔레콤', '네트워크'],
      categories: [
        'DevOps·인프라·보안',
        '백엔드 개발',
        '경영기획·전략·컨설팅',
        '영업·세일즈',
      ],
    },
    // 식음료 · 프랜차이즈
    {
      keywords: ['식품', '음식', '식음료', '커피', '치킨', '음료'],
      categories: [
        '마케팅·광고',
        '영업·세일즈',
        '제조·생산·품질·SCM',
        '경영기획·전략·컨설팅',
      ],
    },
    // 공공기관 · 공기업
    {
      keywords: ['공사', '공단', '진흥원', '재단', '공공기관'],
      categories: [
        '인사·HR·노무',
        '재무·회계·세무',
        '경영기획·전략·컨설팅',
        '법무·CPA·컴플라이언스',
      ],
    },
  ];

/**
 * 회사 industry 와 사용자 직군 list 의 매칭 점수 (0~N).
 * 점수 = industry 매칭 키워드 안의 직군 중 사용자 직군과 겹치는 개수.
 *
 * 예: industry="IT 서비스", userCategories=['백엔드 개발','UI/UX·프로덕트 디자이너']
 *  → IT 키워드 매칭 → 그 그룹 안 '백엔드 개발', 'UI/UX·프로덕트 디자이너' 둘 다 있음 → 점수 2
 */
export function calculateIndustryBoost(
  industry: string | undefined,
  userCategories: string[] | null | undefined,
): number {
  if (!industry || !userCategories || userCategories.length === 0) return 0;
  let score = 0;
  for (const entry of INDUSTRY_BOOST_MAP) {
    const matched = entry.keywords.some((k) => industry.includes(k));
    if (!matched) continue;
    for (const cat of entry.categories) {
      if (userCategories.includes(cat)) score++;
    }
  }
  return score;
}
