import {
  IsString,
  IsOptional,
  IsIn,
  IsDateString,
  IsUrl,
  MaxLength,
  IsBoolean,
} from 'class-validator';

export class CreateApplicationDto {
  @IsString()
  @MaxLength(100)
  companyName: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobTitle?: string;

  @IsOptional()
  @IsString()
  jobCategory?: string;

  @IsOptional()
  @IsIn(['PLANNED', 'IN_PROGRESS'])
  status?: 'PLANNED' | 'IN_PROGRESS';

  @IsOptional()
  @IsDateString()
  deadline?: string;

  @IsOptional()
  @IsUrl()
  jobUrl?: string;

  @IsOptional()
  @IsBoolean()
  needsDetail?: boolean;
}
