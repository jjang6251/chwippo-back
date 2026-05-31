/**
 * F6 PR 2 Phase 4 단계 B — 회사 조사 web_search 허용 도메인 화이트리스트.
 *
 * **저작권·법적 위험 회피 정책**:
 * - 화이트리스트 외 사이트의 정보는 사용 금지
 * - 잡플래닛·블라인드·Glassdoor·Indeed·잡코리아·사람인·LinkedIn 등 후기/연봉 사이트 전면 차단
 * - 회사 측 opt-out 요청 시 24시간 내 cache 삭제 + 차단 리스트 등록
 *
 * **분류**:
 * - 공식 자료: 공시 (DART), 회사 공식 사이트 (광범위 → 정적 화이트리스트엔 X — 위키·언론사 인용 우회)
 * - 언론사: 6대 매체 + 포털 뉴스 (1-2문장 AI 요약은 fair use 인정 판례)
 * - 백과사전: 위키 (CC BY-SA — 출처 명시 의무)
 *
 * **참고**: Anthropic web_search tool 의 `allowed_domains` 파라미터에 전달.
 * 회사 공식 도메인 동적 추가는 후속 (Application 에 website_url 컬럼 신설 시).
 */
export const COMPANY_RESEARCH_ALLOWED_DOMAINS = [
  // 공시·공식 — robots.txt 공개, Anthropic crawler 허용
  'dart.fss.or.kr',
  // 백과사전 — CC BY-SA, crawler 친화적
  'ko.wikipedia.org',
  'en.wikipedia.org',
  // 정부·공공 데이터
  'data.go.kr',
  // Note: 한국 6대 신문사 (chosun·joongang·donga·hankyung·mk·sedaily) +
  // 포털 뉴스 (news.naver·news.daum) 는 Anthropic ClaudeBot crawler 가 차단되어
  // allowed_domains 에 포함 시 400 invalid_request_error 발생.
  // → 신문·블로그 정보가 필요한 경우 LlmService.call 에 webSearch: false 로 fallback,
  //    Claude 학습 데이터 기반 회사 정보 활용 (정확도↓ but 차단 회피)
] as const;

/**
 * 명시적 차단 사이트 (참고용 — 화이트리스트 방식이라 자동 차단되지만 문서·테스트용).
 * 만약 화이트리스트 → 블랙리스트 정책 전환 시 사용.
 */
export const COMPANY_RESEARCH_BLOCKED_DOMAINS = [
  'jobplanet.co.kr',
  'teamblind.com',
  'glassdoor.com',
  'indeed.com',
  'jobkorea.co.kr',
  'saramin.co.kr',
  'wanted.co.kr',
  'linkedin.com',
] as const;
