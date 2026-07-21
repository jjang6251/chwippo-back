import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * App Review(App Store Guideline 2.1) 전용 리뷰어 로그인 요청.
 *
 * 심사관은 카카오 계정을 만들 수 없어 이메일/비밀번호 우회 경로가 필요.
 * 실제 자격은 REVIEWER_EMAIL·REVIEWER_PASSWORD_HASH env 와만 대조 (DB 저장 X).
 */
export class ReviewerLoginDto {
  @IsEmail()
  @MaxLength(320) // RFC 5321 이메일 최대 길이
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200) // bcrypt 는 72바이트에서 잘리지만 입력 자체를 넉넉히 cap (DoS 방어)
  password!: string;
}
