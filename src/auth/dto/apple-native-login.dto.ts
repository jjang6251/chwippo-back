import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Apple 이 첫 sign-in 시에만 제공 · 이후엔 null.
 * client 가 안전한 저장 후 백엔드로 전달.
 */
export class AppleFullNameDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  givenName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  familyName?: string | null;
}

export class AppleNativeLoginDto {
  /**
   * Apple identity token (JWT).
   * expo-apple-authentication signInAsync 응답의 `identityToken` 필드.
   */
  @IsNotEmpty()
  @IsString()
  @MaxLength(10000)
  identityToken: string;

  /**
   * 첫 sign-in 에만 존재 · Apple 이 한 번만 반환.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => AppleFullNameDto)
  fullName?: AppleFullNameDto;
}
