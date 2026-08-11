import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { INTERVIEW_CATEGORIES } from '../interview-categories.const';

/**
 * 질문 단건 patch — 주로 my_memo autosave. suggested_answer 은 LLM 재호출로만 변경 (PATCH 금지).
 *
 * 질문 은행 D1 (2026-08-11) — `questionText`·`category` 추가.
 * 🔴 **`source='user'` 전용은 `questionText` 하나뿐이다** (판정은 service).
 * AI 질문의 본문까지 고칠 수 있게 하면 ↻(낱개 교체)의 기준이 흐려진다 —
 * "AI 가 준 질문" 이 아니게 된 것을 무엇으로 다시 뽑을지가 사라진다.
 * `myMemo`·`category`·`mustPrepare` 는 **모든 질문**에서 열려 있다
 * (내 답변·내 분류·내 준비 표시는 질문을 누가 만들었는지와 무관하다).
 */
export class UpdateQuestionDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  myMemo?: string | null;

  /**
   * 질문 본문. **trim 후 1~500자** 판정은 service (`BulkQuestionItemDto` 와 같은 이유).
   * `@MaxLength` 를 raw 로 걸면 붙여넣기 끝 공백 때문에 멀쩡한 500자가 막힌다.
   */
  @IsOptional()
  @IsString()
  questionText?: string;

  /**
   * 질문 유형. `null` 을 보내면 미분류로 되돌린다 (`@IsOptional` 이 null 을 통과시킨다).
   *
   * 🔴 **`questionText` 와 달리 모든 질문에서 열려 있다** (2026-08-12). AI 가 유형을
   * 애매하게 붙였을 때 바로잡지 못하면 흐름 정렬·시험 범위 필터가 성립하지 않는다.
   * `mustPrepare` 가 전 질문 허용이 된 것과 같은 논지 — 유형은 정체성이 아니라 내 분류다.
   */
  @IsOptional()
  @IsIn(INTERVIEW_CATEGORIES)
  category?: string | null;

  /**
   * ⭐ 우선 준비 표시 (D1b — D1a 판정 #4).
   *
   * 🔴 **`questionText` 와 달리 모든 질문에서 열려 있다.** 이건 AI 가 만든
   * 것인지와 무관한 **내 준비 표시**라서다. user 전용으로 묶으면 「⭐만」 필터가
   * 직접 추가한 질문에서 영원히 비고, 그 필터가 은행의 핵심 동선이다.
   * (`category` 도 같은 논지로 뒤따라 열렸다 — 위 필드 주석)
   */
  @IsOptional()
  @IsBoolean()
  mustPrepare?: boolean;
}
