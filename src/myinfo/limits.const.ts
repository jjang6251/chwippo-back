/**
 * 내정보 창고 섹션별 항목 수 한도.
 * 일반 사용자가 절대 닿을 일 없는 수준 (평균의 2-3배)으로 설정 → 악용만 차단.
 * 변경 시 프론트엔드 UI 표시(예: "12/30")도 함께 갱신.
 */
export const ITEM_LIMITS = {
  cert: 30,
  award: 30,
  languageCert: 10,
  experience: 50,
  coverletterCustom: 30,
  document: 30,
  education: 10,
} as const;

export const ITEM_LABELS: Record<keyof typeof ITEM_LIMITS, string> = {
  cert: '자격증',
  award: '상장',
  languageCert: '어학 성적',
  experience: '활동/경력/인턴/프로젝트',
  coverletterCustom: '자기소개서 항목',
  document: '문서',
  education: '학력',
};
