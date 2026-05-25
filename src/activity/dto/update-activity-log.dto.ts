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
import {
  COVERLETTER_TAGS,
  LOG_CATEGORIES,
  LOG_COMPS,
  LOG_MOODS,
} from './create-activity-log.dto';
import { QuantShapeValidator } from './quant-shape.validator';

export class UpdateActivityLogDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  content?: string;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @IsIn(LOG_CATEGORIES)
  cat?: (typeof LOG_CATEGORIES)[number] | null;

  @IsOptional()
  @IsIn(LOG_MOODS)
  mood?: (typeof LOG_MOODS)[number] | null;

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
