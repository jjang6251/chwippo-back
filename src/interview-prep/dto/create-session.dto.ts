import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  INTERVIEW_TYPES,
  type InterviewTypeValue,
} from '../interview-types.const';

export class CreateSessionDto {
  @IsUUID()
  applicationId: string;

  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @MinLength(1)
  @MaxLength(40)
  round: string;

  @IsOptional()
  @IsIn(INTERVIEW_TYPES)
  interviewType?: InterviewTypeValue;

  /** 사용자가 선택한 자소서 문항 id — 0개 가능. 최대 30개 (token cap 고려) */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsUUID('all', { each: true })
  coverletterIds?: string[];

  /** 자소서 외 추가로 선택한 activity_log id — 0개 가능. 최대 30개 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsUUID('all', { each: true })
  extraLogIds?: string[];

  /**
   * @deprecated v2 (2026-08-06) — **더 이상 프롬프트에 들어가지 않는다.**
   *
   * 공고 정보는 `applications.job_posting`(파싱 결과) 단일 소스로 통일했다. 같은 내용을
   * 두 번 넣게 하던 구조였고 실측상 **세션 8건 중 입력 0건**이었다. 프론트의 입력란도
   * 공고 요건 정리 UI 로 교체됐다.
   *
   * 필드를 남겨둔 이유는 파괴적 변경을 2단계 릴리즈로 다루기 때문이다 — 저장은 되지만
   * **읽는 곳이 없다.** 다시 배선하지 마라 (`interview-context-builder` 참조).
   */
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  jobDescription?: string;

  /** 강조하고 싶은 강점/경험 — Phase 4. 최대 2000자 */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  emphasisPoints?: string;
}
