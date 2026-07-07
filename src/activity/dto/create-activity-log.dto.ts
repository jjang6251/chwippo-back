import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
} from 'class-validator';
import { QuantShapeValidator } from './quant-shape.validator';

/** 행동 분류 12종 — entity LogCategory 와 동일 */
export const LOG_CATEGORIES = [
  // 취준 실전 3종 (auto-tagger v2)
  'coding_test',
  'interview',
  'apply',
  'develop',
  'meeting',
  'presentation',
  'collaboration',
  'conflict_resolution',
  'learning',
  'leadership',
  'volunteer',
  'customer',
  'analysis',
  'creative',
  'other',
] as const;

/** 발휘 역량 10종 */
export const LOG_COMPS = [
  'technical',
  'leadership',
  'communication',
  'planning',
  'analytical',
  'problem_solving',
  'collaboration',
  'creativity',
  'responsibility',
  'adaptability',
] as const;

/** 자소서 매핑 6종 */
export const COVERLETTER_TAGS = [
  'personality',
  'background',
  'job_competency',
  'own_strength',
  'collaboration',
  'challenge',
] as const;

/** 감정 톤 4종 */
export const LOG_MOODS = [
  'proud',
  'learning',
  'frustrated',
  'neutral',
] as const;

export class CreateActivityLogDto {
  @IsString()
  @MaxLength(200)
  content: string;

  @IsDateString()
  occurredAt: string;

  @IsOptional()
  @IsIn(LOG_CATEGORIES)
  cat?: (typeof LOG_CATEGORIES)[number];

  @IsOptional()
  @IsIn(LOG_MOODS)
  mood?: (typeof LOG_MOODS)[number];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(LOG_COMPS, { each: true })
  comps?: Array<(typeof LOG_COMPS)[number]>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsIn(COVERLETTER_TAGS, { each: true })
  cl?: Array<(typeof COVERLETTER_TAGS)[number]>;

  @IsOptional()
  @Validate(QuantShapeValidator)
  quant?:
    | { type: 'before-after'; before: string; after: string; unit?: string }
    | { type: 'count'; value: string; unit: string; metric?: string }
    | { type: 'raw'; raw: string }
    | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];

  @IsOptional()
  @IsObject()
  note?: Record<string, unknown>;
}
