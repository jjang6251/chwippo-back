import {
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateActivityReflectionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  content: string;

  /** 없으면 service 가 현재 주 월요일로 자동 채움 */
  @IsOptional()
  @IsDateString()
  weekStart?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  growth?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  challenges?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  nextActions?: string[];
}

export class UpdateActivityReflectionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  content?: string;

  @IsOptional()
  @IsDateString()
  weekStart?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  growth?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  challenges?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  nextActions?: string[];
}
