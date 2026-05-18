import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const COVERLETTER_CATEGORIES = [
  '지원동기',
  '성장과정·가치관',
  '입사후포부',
  '직무역량·핵심경험',
  '협업·갈등경험',
  '도전·실패경험',
  '기타',
];

export class CreateApplicationCoverletterDto {
  @IsString()
  @MaxLength(500)
  question: string;

  @IsOptional()
  @IsIn(COVERLETTER_CATEGORIES)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  answer?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20000)
  charLimit?: number;
}

export class UpdateApplicationCoverletterDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  question?: string;

  @IsOptional()
  @IsIn(COVERLETTER_CATEGORIES)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  answer?: string;

  // null 보내면 제한 해제
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20000)
  charLimit?: number | null;
}
