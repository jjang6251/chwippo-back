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
import { Type } from 'class-transformer';
import { EmptyToNull, EmptyToUndef } from './transforms';

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
