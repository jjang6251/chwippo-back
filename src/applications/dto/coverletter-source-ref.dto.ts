import {
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * F6 PR 1 — coverletter_source_refs CRUD DTO.
 *
 * **XOR 제약**: `sourceLogId` 와 `sourceReflectionId` 둘 중 정확히 하나만 제공.
 * - DB CHECK 제약이 1차 가드, DTO 레벨 검증이 0차 (더 빠른 에러 + 명확한 메시지)
 */
export class CreateCoverletterSourceRefDto {
  @ValidateIf((o: CreateCoverletterSourceRefDto) => !o.sourceReflectionId)
  @IsUUID()
  sourceLogId?: string;

  @ValidateIf((o: CreateCoverletterSourceRefDto) => !o.sourceLogId)
  @IsUUID()
  sourceReflectionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  snippetText?: string;

  @IsOptional()
  @IsObject()
  partialRange?: Record<string, unknown>;

  /** caller (ai-draft service) 가 true 로 설정. 일반 사용자 명시 추가 시 false (기본) */
  @IsOptional()
  @IsBoolean()
  aiRecommended?: boolean;
}

/**
 * IDOR batch validation 용 DTO — selected_source_ref_ids[] 가 모두 본인 소유 cl + 본인 ref 인지 검증.
 * ai-draft 엔드포인트가 사용 (사용자가 사이드 패널에서 체크한 ref 들).
 */
export class SelectedSourceRefIdsDto {
  @IsArray()
  @IsUUID('all', { each: true })
  selectedSourceRefIds: string[];
}
