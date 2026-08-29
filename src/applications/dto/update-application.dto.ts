import {
  IsString,
  IsOptional,
  IsIn,
  IsDateString,
  IsUrl,
  MaxLength,
  IsInt,
  Min,
  IsBoolean,
  ValidateIf,
} from 'class-validator';
import {
  JOB_TITLE_SOURCES,
  type ApplicationStatus,
  type JobTitleSource,
} from '../application.entity';

export class UpdateApplicationDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobTitle?: string;

  /**
   * 직군·계열 라벨. 🔴 **`null` 을 명시적으로 받는다.**
   *
   * 직무를 고치면 계열은 그 직무에서 다시 파생된다. 그런데 새 직무를 사전이 못 알아들으면
   * 보낼 라벨이 없는데, 그때 필드를 빼 버리면(`undefined`) **옛 계열이 그대로 남는다** —
   * 「승무원」을 「백엔드」로 고쳤는데 태그가 「영업·판매·서비스」인 상태가 그렇게 만들어졌다
   * (2026-08-28 실기). 직무가 바뀐 마당에 옛 계열이 남는 게 비는 것보다 틀리므로,
   * 프론트가 `null` 을 보내 지운다.
   *
   * `IsOptional` 이 `null`·`undefined` 를 모두 건너뛰지만 **`null` 허용이 의도라는 걸**
   * 코드에 남기려고 `ValidateIf` 를 함께 둔다.
   */
  @IsOptional()
  @ValidateIf((_o: UpdateApplicationDto, value: unknown) => value !== null)
  @IsString()
  jobCategory?: string | null;

  @IsOptional()
  @IsIn(['PLANNED', 'IN_PROGRESS', 'PASSED', 'FAILED'])
  status?: ApplicationStatus;

  @IsOptional()
  @IsDateString()
  deadline?: string;

  @IsOptional()
  @IsUrl()
  jobUrl?: string;

  /** 회사 메모 — tiptap JSON 문자열 (텍스트 2000자는 프론트 CharacterCount 가 제한, 여기는 JSON 오버헤드 포함 상한 — 스텝 notes 와 동일 관례) */
  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  memo?: string;

  /** A9 — 탈락 회고. 빈 문자열 = 삭제(null 처리) */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  failedTakeaway?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  currentStepIndex?: number;

  @IsOptional()
  @IsBoolean()
  needsDetail?: boolean;

  @IsOptional()
  @IsBoolean()
  isStarred?: boolean;

  /**
   * 직무를 어떻게 입력했는가 — **관측 전용**. 직무를 고쳐 쓰면 출처도 같이 바뀌므로
   * update 에서도 받는다. `create` 와 같은 이유로 `IsIn` 으로 알려진 값만 통과시킨다.
   */
  @IsOptional()
  @IsIn(JOB_TITLE_SOURCES)
  jobTitleSource?: JobTitleSource;
}
