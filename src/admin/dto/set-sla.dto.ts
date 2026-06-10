import { IsDateString } from 'class-validator';

export class SetSlaDto {
  @IsDateString()
  deadlineAt: string;
}
