/**
 * 면접 종류 enum — PRD `01_product/prd.md` "면접 타입 선택" 6종.
 *
 * 🔴 **값은 추가만 한다.** `interview_prep_sessions.interview_type` 은 varchar(40) 이라
 * DB 제약은 없지만, 이미 저장된 세션이 `technical`·`personality`·`etc` 를 들고 있다.
 * 값을 바꾸면 과거 세션의 라벨과 프롬프트 지시가 동시에 깨진다.
 *
 * v1 은 `technical`·`personality`·`etc` 3종뿐이었다. 3종은 **IT 전제**여서
 * 마케팅·영업·재무 지원자가 "1차 실무면접" 세션을 만들면 고를 게 인성/기타밖에 없었다.
 * 그래서 PRD 에 원래 있던 `job_fit`(실무·직무)·`presentation`·`discussion` 을 추가한다.
 *
 * 라벨·프롬프트 지시는 `interview-context-builder.ts` 의 `INTERVIEW_TYPE_GUIDE` 참조.
 * 프론트 라벨은 `chwippo-front/src/types/interviewPrep.ts` `INTERVIEW_TYPE_LABEL` — 값 동기화 필수.
 */
export const INTERVIEW_TYPES = [
  'job_fit', // 실무·직무 (v2 추가) — 비IT 직군의 기본값
  'personality', // 임원·인성 (v1 'personality' 유지, 라벨만 확장)
  'technical', // 기술 (v1 유지) — IT 직군 라이브 코딩·시스템 설계
  'presentation', // PT·발표 (v2 추가)
  'discussion', // 토론 (v2 추가)
  'etc', // 기타 (v1 유지)
] as const;

export type InterviewTypeValue = (typeof INTERVIEW_TYPES)[number];
