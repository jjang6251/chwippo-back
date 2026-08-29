import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  JOB_CATEGORIES,
  type JobCategory,
} from '../signup-job-categories.const';
import { SIGNUP_SERIES_IDS } from '../signup-series.const';
import { APPLICATION_TEMPLATE_IDS } from '../../applications/application-templates';

/** 문자열 필드 공용 trim — 공백만 적은 값이 "채워진 값"으로 저장되지 않게 */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * signup 1 질문 답변 DTO — **두 경로가 같은 엔드포인트를 쓴다**.
 *
 * | 경로 | 보내는 필드 | 결과 |
 * |---|---|---|
 * | 구 21칩 (하위 호환) | `jobCategories` (+`otherText`) | 가상 회사 샘플 카드 |
 * | 신 계열 1탭 | `jobCategories: []` + `seriesId` (+`jobTitle`·`pickedCompanies`) | 지원 예정(PLANNED) 카드 |
 *
 * 🔴 **`jobCategories` 가 optional 이 됐다.** 새 경로는 직군 칩을 안 쓰지만, 서비스가
 * 이 컬럼(`signup_job_categories`)의 NULL 여부로 「이미 답변했나」를 판정하므로
 * 새 경로도 반드시 `[]` 를 **기록**한다. 미전송이면 서비스가 `[]` 로 취급한다.
 *
 * **jobCategories**: 0~21개. enum 외 값 → 400 IsIn. 22+ → 400 ArrayMaxSize.
 *
 * **otherText**: "기타" 선택 시 자유 입력 (0~200자, trim). "기타" 미포함 + 값 있음 → 서비스 400.
 *
 * **seriesId**: 계열 id 14종 (`SIGNUP_SERIES_IDS` = 프론트 `JOB_SERIES` id 와 문자 그대로 동일).
 *
 * **jobTitle**: 온보딩에서 **사람이 타이핑한** 직무 원문 (0~100자, trim).
 *   계열 라벨은 절대 여기 오지 않는다 — 프리필로 승격되는 값이라 사람 말만 받는다.
 *
 * **pickedCompanies**: 2단 보상에서 고른 회사명 (최대 6, 각 100자, trim).
 *   빈 문자열 제거·중복 제거는 서비스가 한다 (DTO 는 형태만 본다).
 *
 * 🔴 **조합 규칙** — `seriesId` 없이 `pickedCompanies` 만 오면 서비스가 400 을 던진다
 * (「계열 없이 회사만 담을 수 없어요」). 회사 목록은 계열에서 파생되므로 계열이 없으면
 * 그 회사들이 어디서 왔는지 서버가 알 수 없고, 근거 없는 카드가 생기는 셈이 된다.
 */
export class SignupAnswerDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(21)
  @IsString({ each: true })
  @IsIn(JOB_CATEGORIES, { each: true })
  jobCategories?: JobCategory[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  otherText?: string;

  @IsOptional()
  @IsIn(SIGNUP_SERIES_IDS)
  seriesId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trim)
  jobTitle?: string;

  /**
   * 프론트가 **직무 사전으로 확정한** 전형 템플릿 id.
   *
   * 🔴 서버는 사전이 없어 **계열까지만** 안다 (사전은 프론트 단일 소스 — 사본을 두면
   * 드리프트가 시작된다). 그런데 온보딩 보상은 「승무원」에 항공 서비스 전형을 보여주고,
   * 서버가 계열(`sales`)로만 카드를 만들면 **방금 본 미리보기와 담긴 카드가 어긋난다.**
   * 그래서 판정 결과 하나만 받는다 — 사전이 아니라 결론을 넘기는 것이라 사본이 아니다.
   *
   * 없거나 모르는 id 면 `templateForSeries` 폴백. `seriesId` 없이 이것만 오면 무시한다
   * (카드를 안 만드는 경로라 쓸 데가 없다 — 400 을 낼 만큼 위험한 값도 아니다).
   */
  @IsOptional()
  @IsIn(APPLICATION_TEMPLATE_IDS)
  templateId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @Transform(({ value }: { value: unknown }): unknown =>
    Array.isArray(value)
      ? (value as unknown[]).map((v) => (typeof v === 'string' ? v.trim() : v))
      : value,
  )
  pickedCompanies?: string[];
}
