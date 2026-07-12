import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * POST /applications/:id/job-posting/parse — 공고 원문 붙여넣기.
 *
 * `rawText` 는 파싱 입력으로만 쓰고 **저장하지 않음** (금지선). trim 후 30~10,000자.
 */
export class ParseJobPostingDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(30, { message: '공고 내용이 너무 짧아요 (30자 이상).' })
  @MaxLength(10000, { message: '공고 내용이 너무 길어요 (10,000자 이하).' })
  rawText: string;
}

/**
 * PATCH /applications/:id/job-posting — 사용자 수동 수정 (LLM 미경유).
 *
 * 구조화 필드 부분 갱신. 보낸 필드만 교체, 안 보낸 필드는 기존 값 유지.
 * 각 배열 원소 string · 상식선 길이/개수 상한 (남용 방지).
 */
export class UpdateJobPostingDto {
  /** 담당업무. 빈 문자열 → null 로 저장 */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  responsibilities?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  requirements?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  preferred?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  techStack?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  qualifications?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  keywords?: string[];
}
