import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import type {
  AiContentType,
  AiReportReason,
} from '../ai-content-report.entity';

const CONTENT_TYPES: AiContentType[] = [
  'coverletter',
  'interview_answer',
  'note_summary',
  'company_research',
  'other',
];

const REASONS: AiReportReason[] = [
  'hate_speech',
  'misinformation',
  'privacy_violation',
  'harmful_content',
  'copyright',
  'other',
];

export class CreateAiContentReportDto {
  @IsNotEmpty()
  @IsString()
  @IsIn(CONTENT_TYPES)
  contentType!: AiContentType;

  @IsOptional()
  @IsUUID()
  contentId?: string;

  @IsNotEmpty()
  @IsString()
  @IsIn(REASONS)
  reason!: AiReportReason;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  detail?: string;
}
