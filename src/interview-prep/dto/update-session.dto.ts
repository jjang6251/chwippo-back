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

export class UpdateSessionDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @MinLength(1)
  @MaxLength(40)
  round?: string;

  @IsOptional()
  @IsIn(INTERVIEW_TYPES)
  interviewType?: InterviewTypeValue | null;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  myMemo?: string | null;

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
  jobDescription?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  emphasisPoints?: string | null;

  /** Phase 4 — 자료 변경 후 "다시 생성" 흐름. IDOR batch 가드는 service 가 재실행 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsUUID('all', { each: true })
  coverletterIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsUUID('all', { each: true })
  extraLogIds?: string[];
}
