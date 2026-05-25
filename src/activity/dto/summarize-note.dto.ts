import { IsBoolean, IsOptional } from 'class-validator';

export class SummarizeNoteDto {
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
