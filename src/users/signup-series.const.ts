/**
 * 온보딩 계열 id 14종 — **저장 검증 전용**.
 *
 * 🔴 **라벨을 두지 않는다.** 계열 체계의 단일 소스는 프론트 `src/utils/jobRole.ts` 의
 * `JOB_SERIES` 다 (사전·판정·화면이 전부 거기 있다). 백엔드가 라벨까지 들고 있으면
 * 한쪽만 고쳤을 때 조용히 갈리는데, 서버는 라벨을 **한 번도 쓰지 않는다** —
 * 필요한 건 「사용자가 보낸 id 가 우리가 아는 14개 중 하나인가」뿐이다.
 *
 * 그래서 여기 있는 것은 id 배열 하나이고, 값은 `JOB_SERIES` 의 id 와 **문자 그대로**
 * 같아야 한다. (프론트가 없는 id 를 보내면 400 으로 튕겨 오염을 막는다.)
 */
export const SIGNUP_SERIES_IDS = [
  'it',
  'office',
  'finance',
  'health',
  'education',
  'public',
  'research',
  'manufacturing',
  'construction',
  'sales',
  'media',
  'logistics',
  'agriculture',
  'marketing',
] as const;

export type SignupSeriesId = (typeof SIGNUP_SERIES_IDS)[number];
