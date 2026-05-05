import { IsOptional, IsString } from 'class-validator';

export class UpdateStepDetailDto {
  @IsOptional()
  @IsString()
  scheduledDate?: string;

  @IsOptional()
  @IsString()
  location?: string;
}
