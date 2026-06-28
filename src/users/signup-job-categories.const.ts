/**
 * W1 — signup 1 질문의 직군 enum + 가상 회사 list.
 *
 * 21개 직군 (20 + 기타), 5 그룹.
 * 한국 채용 표준 (사람인·잡코리아·원티드 hybrid, 2026-06-26 WebSearch 기반).
 *
 * **scope**: signup 답변용 enum + 샘플 회사 generator. Application.jobCategory 직접 enum X
 * (자유 입력 VARCHAR 유지, sample generator 가 이 list 의 값 그대로 박제).
 */

export const JOB_CATEGORIES = [
  // A. IT·개발 (5)
  '백엔드 개발',
  '프론트엔드 개발',
  '모바일 앱 개발',
  '데이터·AI',
  'DevOps·인프라·보안',
  // B. 디자인·기획 (4)
  'UI/UX·프로덕트 디자이너',
  '그래픽·브랜드 디자이너',
  '서비스 기획·PM',
  '콘텐츠·에디터·PR',
  // C. 마케팅·영업·운영 (3)
  '마케팅·광고',
  '영업·세일즈',
  '고객서비스·CS·CX',
  // D. 경영지원·전문 (4)
  '인사·HR·노무',
  '재무·회계·세무',
  '법무·CPA·컴플라이언스',
  '경영기획·전략·컨설팅',
  // E. 산업·전문직 (4)
  '금융·은행·증권·보험',
  'R&D·연구개발',
  '의료·제약·바이오',
  '제조·생산·품질·SCM',
  // 기타
  '기타',
] as const;

export type JobCategory = (typeof JOB_CATEGORIES)[number];

/** 직군별 가상 회사 list (각 직군 × 2). 1번째 = sample generate 우선 사용 */
export const SAMPLE_COMPANIES: Record<JobCategory, string[]> = {
  '백엔드 개발': ['Cloud Tech 백엔드', 'DataFlow 서버 엔지니어'],
  '프론트엔드 개발': ['Pixel Studio 프론트엔드', 'Sunlight Web 개발'],
  '모바일 앱 개발': ['Aurora Mobile iOS', 'Comet App Android'],
  '데이터·AI': ['Atlas Data DS', 'NorthStar AI/ML 엔지니어'],
  'DevOps·인프라·보안': ['Beacon Infra DevOps', 'Bedrock Security SRE'],
  'UI/UX·프로덕트 디자이너': ['Sunset Design UI/UX', 'Coral Studio 프로덕트'],
  '그래픽·브랜드 디자이너': ['Crystal Brand Design', 'Maple Visual 디자이너'],
  '서비스 기획·PM': ['Bridge Lab PO', 'Northpine 서비스 기획'],
  '콘텐츠·에디터·PR': ['Lumen Editor 콘텐츠', 'Echo PR 커뮤니케이션'],
  '마케팅·광고': ['Blue Marketing 퍼포먼스', 'Wind & Co CRM 마케팅'],
  '영업·세일즈': ['Globe Trade B2B 영업', 'Harbor Sales 솔루션'],
  '고객서비스·CS·CX': ['Compass CX Manager', 'Anchor Customer Success'],
  '인사·HR·노무': ['Stellar HR 리크루터', 'Riverbank People Ops'],
  '재무·회계·세무': ['Bridge Finance 재무', 'Northcap 회계'],
  '법무·CPA·컴플라이언스': ['Pioneer Legal 사내변호사', 'Summit Compliance'],
  '경영기획·전략·컨설팅': ['Atlas Strategy 전략기획', 'Beacon Consulting'],
  '금융·은행·증권·보험': ['Atlas Capital 투자분석', 'Riverbank IB'],
  'R&D·연구개발': ['Quantum Lab R&D', 'Helix Research'],
  '의료·제약·바이오': ['Greenleaf Pharma RA', 'Bluemed 임상연구'],
  '제조·생산·품질·SCM': ['Forge 제조 QA', 'Logix SCM 운영'],
  기타: ['Sample Corp 신입', 'Demo Inc 인턴'],
};

/**
 * 샘플 회사 generate.
 * - jobCategories 첫 3개만 사용 (max 3 카드)
 * - '기타' + otherText 있음 → "Sample Corp {otherText}" 1개
 * - '기타' + otherText 빈 string → SAMPLE_COMPANIES['기타'][0] = "Sample Corp 신입"
 */
export function pickSampleCompanies(
  jobCategories: JobCategory[],
  otherText?: string | null,
): { companyName: string; jobCategory: string }[] {
  const top3 = jobCategories.slice(0, 3);
  return top3.map((cat) => {
    if (cat === '기타' && otherText && otherText.trim().length > 0) {
      return {
        companyName: `Sample Corp ${otherText.trim()}`,
        jobCategory: otherText.trim(),
      };
    }
    return {
      companyName: SAMPLE_COMPANIES[cat][0],
      jobCategory: cat,
    };
  });
}
