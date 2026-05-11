import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateChecklistItemDto {
  @IsString()
  @MaxLength(200)
  content: string;

  @IsOptional()
  @IsInt()
  orderIndex?: number;
}

export class UpdateChecklistItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  content?: string;

  @IsOptional()
  @IsBoolean()
  isDone?: boolean;

  @IsOptional()
  @IsInt()
  orderIndex?: number;
}
