import { IsIn } from 'class-validator';

/**
 * 연습 자가평가 3단 — 「면접 보기」 루프의 reveal 직후 버튼.
 *
 * 3단인 이유: 5점 척도는 고르는 데 생각이 필요하고, 2단(알았다/몰랐다)은
 * 「애매」가 갈 곳이 없다. 시험 설정의 「다시 볼 것만」이 `again` 을 집는다.
 */
export const PRACTICE_RESULTS = ['good', 'soso', 'again'] as const;

export type PracticeResult = (typeof PRACTICE_RESULTS)[number];

/**
 * `POST /interview-prep-questions/:id/practice` body.
 *
 * 🔴 **시각 필드가 없다.** `last_practiced_at` 은 서버 `now()` 로만 찍는다 —
 * 클라이언트 시각은 기기 설정으로 조작되고, 그 값이 "최근에 안 본 것부터" 의 근거가
 * 되면 조작이 곧 순서 조작이 된다. (전역 ValidationPipe 의 `forbidNonWhitelisted` 가
 * 임의 필드를 보내면 400 으로 되돌린다.)
 */
export class PracticeQuestionDto {
  @IsIn(PRACTICE_RESULTS)
  result: PracticeResult;
}
