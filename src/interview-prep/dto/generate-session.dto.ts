import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { INTERVIEW_CATEGORIES } from '../interview-categories.const';

/**
 * 한 번에 만들 수 있는 AI 질문 개수 (질문 은행 D1b, 2026-08-11).
 *
 * 🔴 **기본값이 20인 이유는 배포 창 때문이다.** 옛 프론트는 `count` 를 안 보내고
 * `{ regenerate }` 만 보낸다. 그때 서버가 "전량 삭제 후 재생성" 대신 **20개 추가**를
 * 하는 게 이 전환의 안전 방향이다 (계획 §6.5).
 */
export const GENERATE_COUNT_MIN = 1;
export const GENERATE_COUNT_MAX = 20;
export const GENERATE_COUNT_DEFAULT = 20;

/**
 * `POST /interview-prep-sessions/:id/generate` body.
 *
 * 🔴 **생성은 이제 아무것도 지우지 않는다** (ADR-074 의 파괴적 재생성 폐지).
 * 그래서 `regenerate` 는 의미를 잃었지만 **필드는 남긴다** — 전역 ValidationPipe 가
 * `forbidNonWhitelisted: true` 라, 지우면 옛 프론트(`{ regenerate: false }` 를 항상
 * 보낸다)가 배포 창 동안 **400 을 받고 생성 자체를 못 한다.**
 */
export class GenerateSessionDto {
  /** 이번에 만들 질문 수. 미지정이면 20 (구 프론트 호환) */
  @IsOptional()
  @IsInt()
  @Min(GENERATE_COUNT_MIN)
  @Max(GENERATE_COUNT_MAX)
  count?: number;

  /**
   * 지정하면 그 카테고리로 조준 사격. 미지정이면 "기존 질문에 부족한 카테고리 위주".
   * 화이트리스트는 사용자 직접 추가(`BulkQuestionItemDto`)와 **같은 값**을 쓴다.
   */
  @IsOptional()
  @IsIn(INTERVIEW_CATEGORIES)
  category?: string;

  /**
   * @deprecated 값은 **무시된다.** 배포 창(옛 프론트 + 새 백) 호환용으로만 받는다.
   *   지우면 `forbidNonWhitelisted` 가 옛 프론트 요청을 400 으로 막는다.
   */
  @IsOptional()
  @IsBoolean()
  regenerate?: boolean;
}
