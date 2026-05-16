import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { EmptyToUndef } from './transforms';

/**
 * UserProfile 업데이트 DTO.
 * - 모든 필드 optional (사용자가 일부만 보내도 부분 업데이트)
 * - forbidNonWhitelisted로 unknown 필드 (예: user_id, id) 거부 보장
 * - LRR P1T2 M-1 보수
 */
export class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(50) name?: string;
  @IsOptional() @IsString() @MaxLength(50) name_hanja?: string;
  @IsOptional() @IsString() @MaxLength(10) gender?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() birthdate?: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @IsOptional() @IsString() @MaxLength(100) email_personal?: string;

  @IsOptional() @IsString() @MaxLength(30) military_branch?: string;
  @IsOptional() @IsString() @MaxLength(30) military_type?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() military_start?: string;
  @IsOptional() @EmptyToUndef() @IsDateString() military_end?: string;
  @IsOptional() @IsString() @MaxLength(50) military_unit?: string;

  @IsOptional() @IsInt() @Min(0) @Max(990) goal_toeic?: number;
  @IsOptional() @IsString() @MaxLength(500) goal_certs?: string;
  @IsOptional() @IsString() @MaxLength(500) goal_other?: string;
}
