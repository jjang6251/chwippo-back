import {
  IsString,
  IsOptional,
  IsDateString,
  IsUrl,
  IsArray,
  ValidateNested,
  MaxLength,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

// 빈 문자열을 undefined로 변환 — IsOptional 통과 + dto에서 필드 자체가 제외(=DB 변경 없음).
// 사용자가 입력 안 한 date 필드 등에 사용.
const EmptyToUndef = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  );

// 빈 문자열을 null로 변환 — IsOptional 통과 + dto에 명시적으로 null 포함(=DB가 null로 저장됨).
// 사용자가 파일 첨부를 명시적으로 "제거"하려는 file_url에 사용. 폼 file_url=''로 보내면 DB도 null로 정리.
const EmptyToNull = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (value === '' ? null : value));

// ── Language Cert ─────────────────────────────────────────
export class CreateLanguageCertDto {
  @IsString()
  @MaxLength(50)
  cert_type: string;

  @IsOptional() @IsString() @MaxLength(50) score_grade?: string;
  @IsOptional() @IsString() @MaxLength(100) issuer?: string;
  @IsOptional() @IsString() @MaxLength(100) cert_number?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() acquired_at?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() expires_at?: string;
  @IsOptional() @EmptyToNull() @IsUrl() file_url?: string;
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10 * 1024 * 1024)
  file_size_bytes?: number;
}

export class UpdateLanguageCertDto {
  @IsOptional() @IsString() @MaxLength(50) cert_type?: string;
  @IsOptional() @IsString() @MaxLength(50) score_grade?: string;
  @IsOptional() @IsString() @MaxLength(100) issuer?: string;
  @IsOptional() @IsString() @MaxLength(100) cert_number?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() acquired_at?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() expires_at?: string;
  @IsOptional() @EmptyToNull() @IsUrl() file_url?: string;
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10 * 1024 * 1024)
  file_size_bytes?: number;
}

// ── Cert ──────────────────────────────────────────────────
export class CreateCertDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional() @IsString() @MaxLength(100) issuer?: string;
  @IsOptional() @IsString() @MaxLength(100) cert_number?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() acquired_at?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() expires_at?: string;
  @IsOptional() @EmptyToNull() @IsUrl() file_url?: string;
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10 * 1024 * 1024)
  file_size_bytes?: number;
}

export class UpdateCertDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(100) issuer?: string;
  @IsOptional() @IsString() @MaxLength(100) cert_number?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() acquired_at?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() expires_at?: string;
  @IsOptional() @EmptyToNull() @IsUrl() file_url?: string;
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10 * 1024 * 1024)
  file_size_bytes?: number;
}

// ── Award ─────────────────────────────────────────────────
export class CreateAwardDto {
  @IsString()
  @MaxLength(100)
  contest_name: string;

  @IsOptional() @IsString() @MaxLength(100) award_name?: string;
  @IsOptional() @IsString() @MaxLength(100) org?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() awarded_at?: string;
  @IsOptional() @IsString() @MaxLength(200) content?: string;
  @IsOptional() @EmptyToNull() @IsUrl() file_url?: string;
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10 * 1024 * 1024)
  file_size_bytes?: number;
}

export class UpdateAwardDto {
  @IsOptional() @IsString() @MaxLength(100) contest_name?: string;
  @IsOptional() @IsString() @MaxLength(100) award_name?: string;
  @IsOptional() @IsString() @MaxLength(100) org?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() awarded_at?: string;
  @IsOptional() @IsString() @MaxLength(200) content?: string;
  @IsOptional() @EmptyToNull() @IsUrl() file_url?: string;
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10 * 1024 * 1024)
  file_size_bytes?: number;
}

// ── Experience ────────────────────────────────────────────
export class CreateExperienceDto {
  @IsString()
  @MaxLength(100)
  activity_name: string;

  @IsOptional() @IsString() @MaxLength(100) org?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() start_at?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() end_at?: string;
  @IsOptional() @IsString() @MaxLength(2000) content?: string;
}

export class UpdateExperienceDto {
  @IsOptional() @IsString() @MaxLength(100) activity_name?: string;
  @IsOptional() @IsString() @MaxLength(100) org?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() start_at?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() end_at?: string;
  @IsOptional() @IsString() @MaxLength(2000) content?: string;
}

// ── Education ─────────────────────────────────────────────
export class EducationMinorDto {
  @IsString()
  @MaxLength(20)
  type: string;

  @IsString()
  @MaxLength(50)
  name: string;
}

export class CreateEducationDto {
  @IsString()
  @MaxLength(100)
  school_name: string;

  @IsOptional() @IsString() @MaxLength(100) major?: string;
  @IsOptional() @IsString() @MaxLength(100) minor?: string;
  @IsOptional() @IsString() @MaxLength(50) degree?: string;
  @IsOptional() @IsString() @MaxLength(10) gpa?: string;
  @IsOptional() @IsString() @MaxLength(10) gpa_max?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() start_at?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() end_at?: string;
  @IsOptional() @IsString() @MaxLength(20) status?: string;
  @IsOptional() @IsString() @MaxLength(100) location?: string;
  @IsOptional() @EmptyToNull() @IsUrl() file_url?: string;
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10 * 1024 * 1024)
  file_size_bytes?: number;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EducationMinorDto)
  minors?: EducationMinorDto[];
}

export class UpdateEducationDto {
  @IsOptional() @IsString() @MaxLength(100) school_name?: string;
  @IsOptional() @IsString() @MaxLength(100) major?: string;
  @IsOptional() @IsString() @MaxLength(100) minor?: string;
  @IsOptional() @IsString() @MaxLength(50) degree?: string;
  @IsOptional() @IsString() @MaxLength(10) gpa?: string;
  @IsOptional() @IsString() @MaxLength(10) gpa_max?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() start_at?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() end_at?: string;
  @IsOptional() @IsString() @MaxLength(20) status?: string;
  @IsOptional() @IsString() @MaxLength(100) location?: string;
  @IsOptional() @EmptyToNull() @IsUrl() file_url?: string;
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10 * 1024 * 1024)
  file_size_bytes?: number;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EducationMinorDto)
  minors?: EducationMinorDto[];
}
