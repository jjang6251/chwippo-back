import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ANNOUNCEMENT_KINDS, CTA_PATH_PATTERN } from '../announcement.entity';
import type { AnnouncementKind } from '../announcement.entity';

/** 앞뒤 공백은 값이 아니다 — 길이·패턴 검증보다 **먼저** 털어낸다. */
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateAnnouncementDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  body: string;

  @IsEnum(['banner', 'modal'])
  type: 'banner' | 'modal';

  /** 생략 시 'notice' (기본값은 서비스에서 채운다 — DB DEFAULT 와 같은 값) */
  @IsOptional()
  @IsEnum(ANNOUNCEMENT_KINDS)
  kind?: AnnouncementKind;

  @IsBoolean()
  active: boolean;

  /** cta_path 와 항상 짝 — 한쪽만 오면 서비스에서 400 */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'CTA 라벨을 적어 주세요.' })
  @MaxLength(30, { message: 'CTA 라벨은 30자까지예요.' })
  cta_label?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200, { message: 'CTA 경로는 200자까지예요.' })
  @Matches(CTA_PATH_PATTERN, {
    message: 'CTA 경로는 앱 내부 경로(/로 시작)만 가능해요',
  })
  cta_path?: string | null;

  @IsOptional()
  @IsISO8601()
  starts_at?: string;

  @IsOptional()
  @IsISO8601()
  ends_at?: string;
}
