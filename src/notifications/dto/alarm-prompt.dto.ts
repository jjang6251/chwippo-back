import { IsBoolean } from 'class-validator';

/**
 * soft-ask 모달 응답 · 또는 앱 시작 시 OS 권한 상태 동기화.
 * granted = OS 푸시 권한 실제 허용 여부.
 */
export class AlarmPromptDto {
  @IsBoolean()
  granted!: boolean;
}
