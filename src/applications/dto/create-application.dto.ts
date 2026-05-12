import {
  IsString,
  IsOptional,
  IsIn,
  IsDateString,
  IsUrl,
  MaxLength,
  IsBoolean,
} from 'class-validator';
import { APPLICATION_TEMPLATE_IDS } from '../application-templates';

export class CreateApplicationDto {
  @IsString()
  @MaxLength(100)
  companyName: string;

  // 전형 템플릿 id — 미지정/미존재 시 'general'. status=IN_PROGRESS일 때만 초기 스텝에 적용
  @IsOptional()
  @IsString()
  @IsIn(APPLICATION_TEMPLATE_IDS)
  templateId?: string;

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
