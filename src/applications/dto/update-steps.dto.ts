import { Type } from 'class-transformer';
import { IsArray, IsInt, IsISO8601, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';

export class StepItemDto {
  @IsInt()
  @Min(0)
  orderIndex: number;

  @IsString()
  @MaxLength(50)
  name: string;

  @IsOptional()
  @IsISO8601()
  scheduledDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  location?: string;
}

export class UpdateStepsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StepItemDto)
  steps: StepItemDto[];
}
