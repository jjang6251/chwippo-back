import { IsOptional, IsUUID } from 'class-validator';

/**
 * POST /auth/refresh 본문 — 회전 멱등성 (2026-08-15).
 *
 * `rotationId` 는 클라가 발급하는 **회전 1건의 접수번호**다. 재시도가 같은 값을 재사용하면
 * 서버가 "새 시도" 가 아니라 "같은 회전의 재전송" 으로 알아보고, 응답 유실로 소비된 RT 만
 * 남은 기기를 창(30초) 안에서 복구시킨다.
 *
 * 🔴 **UUID 형식을 강제한다.** 임의 문자열을 그대로 받으면 (a) `rotation_id uuid` 컬럼에
 * 넣는 순간 DB 에러가 나고, (b) 길이 제한 없는 값이 audit `detail` 로 흘러들어간다.
 * 형식 위반은 400 — 정상 클라는 `crypto.randomUUID()` 결과만 보낸다.
 *
 * 구버전 클라는 이 필드를 아예 보내지 않는다 → `@IsOptional` (호환 필수).
 */
export class RefreshDto {
  @IsOptional()
  @IsUUID()
  rotationId?: string;
}
