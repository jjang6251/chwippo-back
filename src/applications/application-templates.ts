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

  // ── 계열 14 전용 템플릿 (2026-08-28) ────────────────────────────────
  // 온보딩이 계열 1탭으로 바뀌면서 「계열을 골랐는데 전형은 일반 대기업」이 되는
  // 구멍이 생겼다. 프론트 `utils/stepTemplates.ts` 의 **라벨 포함 원본**과 id·스텝
  // 문자열이 정확히 같아야 한다 (라벨은 화면 문구라 프론트에만 둔다).
  office: ['서류 제출', '인적성', '1차 실무면접', '2차 임원면접', '최종 합격'],
  health: ['서류 제출', '면접', '신체검사', '최종 합격'],
  education: ['서류 제출', '수업 시연·필기', '면접', '최종 합격'],
  research: ['서류 제출', '전공 필기·PT', '기술면접', '임원면접', '최종 합격'],
  manufacturing: ['서류 제출', '인적성', '실무면접', '임원면접', '최종 합격'],
  construction: ['서류 제출', '면접(직무·인성)', '채용검진', '최종 합격'],
  sales: [
    '서류 제출',
    '인적성·AI역량검사',
    '1차 실무면접',
    '2차 면접',
    '최종 합격',
  ],
  logistics: ['서류 제출', '인적성·필기', '면접', '최종 합격'],
  agriculture: ['서류 제출', '필기·인적성', '면접', '최종 합격'],
  marketing: [
    '서류 제출',
    '과제(기획안)',
    '1차 실무면접',
    '2차 면접',
    '최종 합격',
  ],

  // 계열보다 좁은 **세밀 그룹** 전용 — 같은 계열 안에서 전형이 통째로 다른 갈래들.
  // (금융공공은 필기가 핵심이고, 승무원은 체력·신체검사가 붙고, 경찰·소방은 체력검정이 붙는다)
  finance_public: [
    '서류 제출',
    '필기(전공·논술)',
    '1차 면접',
    '2차 면접',
    '최종 합격',
  ],
  air_service: [
    '서류 제출',
    '1차 실무면접',
    '2차 임원·영어면접',
    '체력·신체검사',
    '최종 합격',
  ],
  uniformed: ['서류 제출', '필기', '체력검정', '면접·신체검사', '최종 합격'],
  teacher_exam: ['서류 제출', '1차 필기', '2차 수업실연·심층면접', '최종 합격'],

  custom: ['서류 제출', '1차 면접', '2차 면접', '최종 합격'], // = general (사용자가 만든 뒤 편집)
};

export const APPLICATION_TEMPLATE_IDS = Object.keys(APPLICATION_TEMPLATES);

/**
 * 계열 id → 전형 템플릿 — 프론트 `utils/stepTemplates.ts` 의 `SERIES_TEMPLATE` **사본**.
 *
 * 🔴 **사본인 이유** — 온보딩 2단에서 고른 회사 카드는 **서버가 만든다.** 그 순간 서버는
 * 계열 id 만 알고 있고(직무 분류 사전은 프론트 단일 소스라 여기 없다), 스텝을 안 만들면
 * 「담아줬다는데 카드가 비어 있는」 상태가 된다.
 *
 * 🔴 **여긴 계열까지만이고, 그게 폴백이다.** 프론트에는 세밀 그룹 오버라이드
 * (`FINE_TEMPLATE` — 금융공공·승무원·경찰 등)와 「임용」 규칙이 더 있는데 그건
 * 사전(`utils/jobRole.ts`)이 있어야 도는 판정이라 서버가 재현할 수 없다. 사전 사본은
 * 여전히 두지 않되, **판정 결과 한 개**(`SignupAnswerDto.templateId`)를 프론트에서 받아
 * 미리보기와 카드가 어긋나지 않게 한다 — 사전이 아니라 결론을 넘기는 것이라 사본이 아니다.
 * 그 값이 없거나 모르는 id 면 이 표로 떨어진다.
 */
export const SERIES_TEMPLATE: Record<string, string> = {
  it: 'it_dev',
  office: 'office',
  finance: 'finance',
  health: 'health',
  education: 'education',
  public: 'public',
  research: 'research',
  manufacturing: 'manufacturing',
  construction: 'construction',
  sales: 'sales',
  media: 'media',
  logistics: 'logistics',
  agriculture: 'agriculture',
  marketing: 'marketing',
};

/** 계열 id → 템플릿 id. 모르는 계열이면 `general` (억지로 배정하지 않는다) */
export function templateForSeries(seriesId?: string | null): string {
  return (seriesId && SERIES_TEMPLATE[seriesId]) || 'general';
}

export function stepsForTemplate(templateId?: string | null): string[] {
  return (
    (templateId && APPLICATION_TEMPLATES[templateId]) ||
    APPLICATION_TEMPLATES.general
  );
}
