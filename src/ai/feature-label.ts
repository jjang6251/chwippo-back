import type { LlmFeature } from './entities/llm-call-log.entity';

/** 사용자 통지용 feature 한국어 라벨 (④ 한도 통지 문구) */
const FEATURE_LABEL: Partial<Record<LlmFeature, string>> = {
  coverletter_draft_v2: 'AI 자소서 초안',
  coverletter_feedback: 'AI 자소서 제출 전 점검',
  coverletter_recommend: 'AI 소재 추천',
  coverletter_chat: 'AI 자소서 대화',
  interview_prep_session: 'AI 면접 준비',
  interview_prep_followup: 'AI 꼬리질문',
  company_research: '회사 조사',
  note_summary: 'AI 노트 요약',
};

export function getFeatureLabel(feature: LlmFeature): string {
  return FEATURE_LABEL[feature] ?? 'AI 기능';
}
