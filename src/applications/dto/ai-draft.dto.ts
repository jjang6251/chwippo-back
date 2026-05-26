import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
} from 'class-validator';

/**
 * F6 PR 1 — POST /coverletters/:clId/ai-draft 입력.
 *
 * `selectedSourceRefIds[]` 는 사용자가 사이드 패널에서 체크한 source_refs row id 들.
 * IDOR batch validation 으로 모두 본인 cl·본인 ref 검증 (Critical #3).
 */
export class GenerateAiDraftDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50) // 컨텍스트 빌더 MAX_LOGS 와 동일 — selected 만으로 cap 초과 차단
  @IsUUID('all', { each: true })
  selectedSourceRefIds?: string[];

  /** true 면 AI 추천 단계 skip (사용자가 본인 선택만으로 진행). recommend quota 안 씀 */
  @IsOptional()
  @IsBoolean()
  skipRecommend?: boolean;
}
