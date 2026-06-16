import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 질문 단건 patch — 주로 my_memo autosave. suggested_answer 은 LLM 재호출로만 변경 (PATCH 금지).
 */
export class UpdateQuestionDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  myMemo?: string | null;
}
