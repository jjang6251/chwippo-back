import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { SIGNUP_SERIES_IDS } from '../signup-series.const';

/** 문자열 필드 공용 trim — 공백만 적은 값이 "채워진 값"으로 저장되지 않게 */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * 희망 직무·계열 변경 DTO — `PATCH /users/me/job-profile`.
 *
 * 온보딩에서 한 번 정한 값을 **나중에 바꾸는 유일한 경로**다 (내 정보 › 기본 인적사항 ·
 * 카드 추가 모달의 「앞으로도 ‘X’로 채우기」).
 *
 * ## 🔴 「사람 말만 볼펜」 — 계열 라벨은 `jobTitle` 로 오지 않는다
 *
 * `jobTitle` 에 들어갈 수 있는 건 **사람이 타이핑한 직무 원문**뿐이다 («간호사»).
 * 「의료·보건·복지」같은 **계열 라벨은 시스템 말**이라 절대 이 칸으로 오면 안 된다 —
 * 그 값이 카드 프리필과 자소서·면접 AI 의 기준으로 승격되기 때문이고, 예전 직군 칩
 * 자동 선택이 데이터를 오염시킨 경로가 정확히 이것이었다. 계열은 `seriesId`(ASCII 안정키)
 * 로만 받는다.
 *
 * ## 부분 갱신
 *
 * - 보낸 필드만 바뀐다. 미전송(`undefined`)은 **손대지 않는다**
 * - 명시적 `null` = 「비우기」 (직무를 지우거나 계열을 푸는 경로)
 * - 빈 문자열·공백만 → 서비스가 `null` 로 저장한다 (채워진 값으로 세지 않는다)
 * - 🔴 **둘 다 미전송이면 400** — 서비스가 「바꿀 값이 없어요」로 튕긴다.
 *   빈 body 를 204 로 받으면 프론트 버그(무한 no-op PATCH)가 조용히 숨는다
 */
export class UpdateJobProfileDto {
  /**
   * 직무 원문 (0~100자, trim). `null` = 비우기.
   *
   * `IsOptional` 이 `null`·`undefined` 를 모두 건너뛰지만, **`null` 허용이 의도라는 걸**
   * 코드에 남기려고 `ValidateIf` 를 함께 둔다 (나중에 `IsOptional` 을 걷어내도 null 이 살아남게).
   */
  @IsOptional()
  @ValidateIf((_o: UpdateJobProfileDto, value: unknown) => value !== null)
  @IsString()
  @MaxLength(100)
  @Transform(trim)
  jobTitle?: string | null;

  /** 계열 id 14종 (프론트 `JOB_SERIES` id 와 문자 그대로 동일). `null` = 계열 풀기 */
  @IsOptional()
  @ValidateIf((_o: UpdateJobProfileDto, value: unknown) => value !== null)
  @IsIn(SIGNUP_SERIES_IDS)
  seriesId?: string | null;
}
