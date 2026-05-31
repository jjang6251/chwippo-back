import { IsString, MaxLength, MinLength } from 'class-validator';

export class AgreeAiConsentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  version: string;
}
