import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { sanitizePastedText } from '../job-posting-card.rules';

/**
 * `POST /applications/from-posting` — 공고 원문 붙여넣기 → 카드 한 장.
 *
 * 🔴 `rawText` 는 파싱 입력으로만 쓰고 **저장하지 않는다** (금지선 — `jobposting_parse` 와 같은 정책).
 * 응답·DB·로그 어디에도 원문이 들어가지 않는다 (`llm_call_logs` 는 sha256 + 스크럽된 200자
 * 발췌만 남긴다 — 기존 파서와 동일).
 */
export class CreateFromPostingDto {
  /**
   * 위생 처리를 **길이 검증보다 먼저** 한다 — 순서가 바뀌면 zero-width 를 30자 채워
   * 최소 길이를 통과시킬 수 있다.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? sanitizePastedText(value) : value,
  )
  @IsString()
  @MinLength(30, { message: '공고 내용이 너무 짧아요 (30자 이상).' })
  @MaxLength(10000, { message: '공고 내용이 너무 길어요 (10,000자 이하).' })
  rawText: string;

  /**
   * 복수 직무 공고에서 사용자가 고른 직무 (2차 파싱 컨텍스트).
   * 부문마다 요건이 통째로 달라서, 고른 뒤 그 직무로 한 번 더 파싱한다.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? sanitizePastedText(value) : value,
  )
  @IsString()
  @MaxLength(100)
  jobContext?: string;
}

/**
 * `POST /applications/from-posting/commit` — 보완 질문에 답하고 카드 생성.
 *
 * 🔴 **초안 본문을 받지 않는다.** `hash` 로 서버가 들고 있는 초안을 가리킬 뿐이다.
 * 클라이언트가 초안을 되돌려 보내는 설계였다면 파싱하지 않은 값을 「AI 가 채운 칸」으로
 * 저장시킬 수 있다 (`posting-draft.store.ts` 주석 참조).
 */
export class CommitFromPostingDto {
  /** 원문의 sha256 — 초안 조회 키. 형식이 아니면 400 (조회 전에 거른다) */
  @IsString()
  @Matches(/^[0-9a-f]{64}$/, { message: '초안 식별자 형식이 올바르지 않아요.' })
  hash: string;

  /** 회사명 보완 — 이 값이 오면 **2차 파싱 없이** 그대로 카드를 만든다 */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? sanitizePastedText(value) : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  companyName?: string;

  /**
   * 직무 보완 — 초안의 후보 중 고른 값(또는 직접 입력). 🔴 여기서는 **재파싱하지 않는다**
   * (원문이 없다). 정상 흐름의 2차 파싱은 `POST /from-posting {rawText, jobContext}` 재호출이고,
   * 이 경로는 새로고침으로 원문을 잃은 뒤의 복구용이다 (`JobPostingCardService.commitDraft` 참조).
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? sanitizePastedText(value) : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  jobContext?: string;
}

/**
 * `PATCH /applications/:id/posting-meta` — 「좋아요」·[확인]·인라인 수정 기록 (멱등).
 *
 * LLM 미경유·차감 없음. `editedFields` 는 **누적 합집합**이다 — 「AI 값 수정률」이
 * 마지막 요청만 반영하면 두 칸을 따로 고친 사용자가 한 칸만 고친 것으로 집계된다.
 */
export class UpdatePostingMetaDto {
  @IsOptional()
  @IsBoolean()
  reviewed?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  editedFields?: string[];
}
