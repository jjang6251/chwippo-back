// 전형 템플릿 — 카드 생성 시 초기 application_steps를 결정. 만든 뒤엔 스텝 편집으로 자유 조정.
// 모든 템플릿은 '서류 제출'로 시작하고 '최종 합격'으로 끝난다 (결과 배지·합격 모달·마감일→첫 스텝 로직 호환).
export const APPLICATION_TEMPLATES: Record<string, string[]> = {
  general: ['서류 제출', '1차 면접', '2차 면접', '최종 합격'],
  it_dev: [
    '서류 제출',
    '코딩테스트·과제',
    '1차 기술면접',
    '2차 컬처핏',
    '최종 합격',
  ],
  public: ['서류 제출', '필기(NCS)', '면접', '최종 합격'],
  finance: [
    '서류 제출',
    '인적성',
    '1차 실무면접',
    '2차 PT·토론',
    '임원면접',
    '최종 합격',
  ],
  startup: ['서류 제출', '과제 전형', '1차 면접', '대표 면접', '최종 합격'],
  media: ['서류 제출', '필기', '실무 평가', '면접', '최종 합격'],
  internship: ['서류 제출', '면접', '최종 합격'],
  custom: ['서류 제출', '1차 면접', '2차 면접', '최종 합격'], // = general (사용자가 만든 뒤 편집)
};

export const APPLICATION_TEMPLATE_IDS = Object.keys(APPLICATION_TEMPLATES);

export function stepsForTemplate(templateId?: string | null): string[] {
  return (
    (templateId && APPLICATION_TEMPLATES[templateId]) ||
    APPLICATION_TEMPLATES.general
  );
}
