import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateStepDetailDto {
  @IsOptional()
  @IsString()
  scheduledDate?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  pinnedContent?: string;
}
