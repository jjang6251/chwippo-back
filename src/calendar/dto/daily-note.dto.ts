import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class CreateDailyNoteDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date: string;

  @IsInt()
  @Min(0)
  @Max(35)
  hourSlot: number;

  @IsString()
  @MaxLength(200)
  content: string;
}

export class UpdateDailyNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  content?: string;

  @IsOptional()
  @IsBoolean()
  isDone?: boolean;
}
