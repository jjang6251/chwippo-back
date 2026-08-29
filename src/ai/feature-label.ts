import type { LlmFeature } from './entities/llm-call-log.entity';

/** 사용자 통지용 feature 한국어 라벨 (④ 한도 통지 문구) */
const FEATURE_LABEL: Partial<Record<LlmFeature, string>> = {
  coverletter_draft_v2: 'AI 자소서 초안',
  coverletter_feedback: 'AI 자소서 제출 전 점검',
  coverletter_recommend: 'AI 소재 추천',
  coverletter_chat: 'AI 자소서 대화',
  interview_prep_session: 'AI 면접 준비',
  // 2026-08-06 신설 때 누락 — 한도 통지가 "AI 기능"으로 뭉개졌다 (위생 ㉕, 2026-08-19 동승)
  interview_prep_answer: 'AI 모범 답안',
  interview_prep_followup: 'AI 꼬리질문',
  note_summary: 'AI 노트 요약',
  jobposting_parse: 'AI 공고 요건 정리',
  jobposting_card: 'AI 공고로 카드 만들기',
  note_ai_action: '노트 AI',
};

export function getFeatureLabel(feature: LlmFeature): string {
  return FEATURE_LABEL[feature] ?? 'AI 기능';
}
