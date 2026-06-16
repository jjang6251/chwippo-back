import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 꼬리질문 on-demand 생성 — `POST /interview-prep-questions/:parentId/followups`.
 * 부모 질문의 depth 0 또는 1 일 때만 호출 가능 (자식은 depth 1 또는 2). depth 2 부모는 차단 (400).
 */
export class CreateFollowupDto {
  /** 사용자가 추가로 힌트 (선택) — 예: "이 답변의 weakness 를 더 깊이 파고드는 질문" */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  hint?: string;
}
