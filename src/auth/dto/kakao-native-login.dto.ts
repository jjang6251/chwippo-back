import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * W2 RN — mobile 카카오 네이티브 SDK 로그인 요청.
 *
 * Kakao access_token 은 일반적으로 ~250자 정도 (JWT 유사 base64).
 * 여유롭게 2000자 cap.
 */
export class KakaoNativeLoginDto {
  @IsNotEmpty()
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  accessToken!: string;
}
