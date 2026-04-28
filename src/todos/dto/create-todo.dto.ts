import { IsDateString, IsNotEmpty, IsString } from 'class-validator';

export class CreateTodoDto {
  @IsString()
  @IsNotEmpty()
  content: string;

  @IsDateString()
  date: string;
}
