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

export class UpdateAnnouncementDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  body?: string;

  @IsOptional()
  @IsEnum(['banner', 'modal'])
  type?: 'banner' | 'modal';

  @IsOptional()
  @IsEnum(ANNOUNCEMENT_KINDS)
  kind?: AnnouncementKind;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  /** null 두 개를 보내면 CTA 를 지운다 — 한쪽만 null 이면 400 (고아 방지) */
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
  starts_at?: string | null;

  @IsOptional()
  @IsISO8601()
  ends_at?: string | null;
}
