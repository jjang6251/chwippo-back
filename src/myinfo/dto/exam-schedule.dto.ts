import { IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateExamScheduleDto {
  @IsIn(['language', 'cert'])
  exam_type: 'language' | 'cert';

  @IsOptional()
  @IsString()
  @MaxLength(50)
  cert_type?: string;

  @IsString()
  @MaxLength(100)
  name: string;

  @IsDateString()
  exam_date: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  memo?: string;
}

export class UpdateExamScheduleDto {
  @IsOptional()
  @IsIn(['language', 'cert'])
  exam_type?: 'language' | 'cert';

  @IsOptional()
  @IsString()
  @MaxLength(50)
  cert_type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsDateString()
  exam_date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  memo?: string;
}

export class ConvertExamToCertDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  score_grade?: string;
}
