import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Apple → Server 알림 payload.
 *
 * Apple 이 전송하는 형식은 `{ "payload": "<JWT>" }`.
 * JWT 안에 events (stringified JSON) 가 포함됨.
 */
export class AppleS2SNotificationDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(20000)
  payload!: string;
}
