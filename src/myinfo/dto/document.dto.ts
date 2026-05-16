import {
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Document(파일 보관함) 생성 DTO.
 * - file_url 필수 (보관함은 파일이 1차 데이터, data-schema.md)
 * - file_url ownership 검증은 MyinfoService.createWithLocks가 처리 (PR F M-2)
 */
export class CreateDocumentDto {
  @IsString() @MaxLength(100) title: string;

  @IsOptional() @IsString() @MaxLength(50) category?: string;

  @IsUrl() file_url: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10 * 1024 * 1024)
  file_size_bytes?: number;
}
