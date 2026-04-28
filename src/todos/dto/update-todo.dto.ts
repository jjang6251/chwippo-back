import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateTodoDto {
  @IsString()
  @IsOptional()
  content?: string;

  @IsBoolean()
  @IsOptional()
  is_done?: boolean;
}
