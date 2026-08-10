/**
 * 면접 질문 카테고리 enum — deep research 2026-06-01 verified.
 * 1차 (Incruit 2024 · 잡코리아 · 잡소설) + 2차 (직무별 verified) 결과 통합.
 *
 * Base (모든 직무 공통): 자기소개·지원동기·인성·실패·협업·임원/가치·컬처핏
 * 직무별 (jobCategory fork): 개발=CS / 기획=비즈니스추론 / 마케팅=데이터·트렌드 / 영업=고객·실적 / 디자인=포트폴리오·프로세스
 * 자소서 기반 추궁 = 자료 기반 깊이 있는 질문 (자소서 답변 인용)
 *
 * 🔴 **`interview-prep-ai.service.ts` 에 있던 것을 여기로 옮겼다** (질문 은행 D1, 2026-08-11).
 * 사용자가 직접 추가하는 질문의 카테고리도 **같은 화이트리스트**를 써야 하는데,
 * 그 DTO 가 `ai.service` 를 import 하면 순환이 생긴다
 * (`questions.service` → dto → `ai.service` → `questions.service`).
 * 순환 자체보다 나쁜 건 **데코레이터가 모듈 평가 시점에 `undefined` 를 받는 것**이라
 * (`@IsIn(undefined)`) 조용히 검증이 죽는다. 그래서 값만 별도 모듈로 내렸다 —
 * `interview-types.const.ts` 와 같은 자리다. `normalizeCategory` 는 생성 경로 전용이라
 * `ai.service` 에 그대로 뒀다.
 *
 * 프론트 라벨은 `chwippo-front/src/types/interviewPrep.ts` `CATEGORY_LABEL` — 값 동기화 필수.
 */
export const INTERVIEW_CATEGORIES = [
  'self_intro', // 자기소개 (PEC 3단)
  'motivation', // 지원동기
  'personality', // 인성/장단점
  'failure', // 실패 극복
  'collaboration', // 협업·갈등
  'executive', // 임원/가치관
  'culture_fit', // 컬처핏 (회사 조사 활용)
  'cs_tech', // CS 기술 (개발 직무)
  'business_reasoning', // 비즈니스 추론·재무 (기획)
  'data_metrics', // 데이터/지표 (마케팅)
  'trend_ai', // AI 시대 트렌드 (마케팅)
  'customer_handling', // 고객 대응 (영업)
  'performance', // 실적/목표 달성 (영업)
  'portfolio_decision', // 포트폴리오 의사결정 근거 (디자인)
  'design_process', // 디자인 프로세스·방법론 (디자인)
  'coverletter_based', // 자소서 기반 추궁
  'company_industry', // 회사·산업 (회사 조사 활용) — "왜 우리 회사여야 하나" 포함
  'reverse_question', // 역질문 (면접관에게 물을 것)
  // ── v2 (2026-08-06) 추가 — 면접 공통 질문 10종 대조에서 빠져 있던 2개 ──
  // 🔴 **추가만 한다. 기존 값 제거·개명 금지** — `interview_prep_questions.category` 에
  //   이미 저장된 값이 있고, 스키마 enum 과 DB 값이 어긋나면 과거 세션이 깨진다.
  'aspiration', // 입사 후 포부 (기존 enum 에 아예 없었다)
  'closing_remark', // 마지막으로 하고 싶은 말 — 역질문과 다른 질문이다
  // ── v2 (2026-08-06) 직무 fork 확장 ──
  // 재무·연구·제조·경영지원·서비스직은 전용 카테고리가 없어 fork 자체가 안 잡혔다.
  // 직군마다 카테고리를 새로 파면 enum 이 5개 늘어나므로, **공용 1개**로 받고
  // 무엇을 물을지는 `buildJobForkHint` 의 직무별 가이드가 정한다.
  'domain_knowledge', // 직무 전문 지식 (재무·연구·제조·법무·서비스 등)
  // ── v2.1 (2026-08-07) PT·토론 전용 ──
  // 이 둘은 **질문이 아니라 준비 재료**다. PT 는 발표할 주제, 토론은 논제라서
  // 기존 카테고리(자소서 기반·직무 지식)에 넣으면 화면에서 성격이 뭉개진다.
  'presentation_topic', // PT — 발표 주제
  'presentation_qa', // PT — 발표 후 예상 질의응답
  'discussion_topic', // 토론 — 찬반 논제 (양쪽 논거를 다 준비하는 형태)
] as const;
