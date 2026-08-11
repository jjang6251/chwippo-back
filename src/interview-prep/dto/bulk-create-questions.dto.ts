import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { INTERVIEW_CATEGORIES } from '../interview-categories.const';

/** 한 번에 담을 수 있는 질문 개수 — 붙여넣기 브리지의 상한과 같은 값 */
export const BULK_MAX_ITEMS = 50;

/**
 * 질문 은행 — 사용자가 직접 추가하는 질문 1건.
 *
 * 🔴 **길이 검증이 여기 없는 이유** — 규칙이 「**trim 후** 1~500자」라
 * `@MaxLength(500)` 로는 못 쓴다 (붙여넣기 끝의 개행·공백 때문에 멀쩡한 500자가 막힌다).
 * trim 정규화와 길이 판정을 한 곳에서 하려고 service 로 내렸고,
 * 그래서 400 문구에 실제 숫자(1~500)가 실린다.
 */
export class BulkQuestionItemDto {
  @IsString()
  questionText: string;

  /**
   * 카테고리 — 선택이다 (강제하지 않는다).
   *
   * 🔴 **미지정은 `null`(미분류) 로 저장된다.** 옛 세션·LLM 이 enum 밖 값을 낸 질문이
   * 이미 `null` 로 있고, 화면·프롬프트가 그걸 「미분류」로 받는다. 여기만 다른 값을 쓰면
   * 같은 뜻이 두 표현이 된다.
   */
  @IsOptional()
  @IsIn(INTERVIEW_CATEGORIES)
  category?: string;

  /**
   * 꼬리질문으로 달 부모 질문 id (선택). 없으면 톱레벨(depth 0).
   * 소유·같은 세션·루트 출처·depth·부모당 캡 판정은 service 가 한다.
   */
  @IsOptional()
  @IsUUID()
  parentQuestionId?: string;
}

/**
 * `POST /interview-prep-sessions/:id/questions/bulk` body.
 *
 * 단건 추가(✍️ 직접 적기)·여러 개 붙여넣기(📋)·직접 꼬리를 **한 엔드포인트로 단일화**했다.
 * 세 화면이 결국 같은 일(내 질문 N개를 세션에 넣기)을 하고, 나누면 캡·트랜잭션·순서 규칙을
 * 세 번 구현하게 된다.
 */
export class BulkCreateQuestionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => BulkQuestionItemDto)
  items: BulkQuestionItemDto[];
}
