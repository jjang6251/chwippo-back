import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const COVERLETTER_CATEGORIES = [
  '지원동기',
  '성장과정·가치관',
  '입사후포부',
  '직무역량·핵심경험',
  '협업·갈등경험',
  '도전·실패경험',
  '기타',
];

export class CreateApplicationCoverletterDto {
  @IsString()
  @MaxLength(500)
  question: string;

  @IsOptional()
  @IsIn(COVERLETTER_CATEGORIES)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  answer?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20000)
  charLimit?: number;

  /**
   * A1 — 답변 출처 (통계·activation 해석용 — 과금 무관이라 클라이언트 신고 허용).
   * 직접 타이핑=manual(default) · 가져오기 모달=imported · chat 제안 적용=ai_draft.
   * 답변 첫 저장 시 1회만 반영, 이후 불변 (서버 강제).
   */
  @IsOptional()
  @IsIn(['manual', 'imported', 'ai_draft'])
  answerOrigin?: 'manual' | 'imported' | 'ai_draft';
}

export class UpdateApplicationCoverletterDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  question?: string;

  @IsOptional()
  @IsIn(COVERLETTER_CATEGORIES)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  answer?: string;

  // null 보내면 제한 해제
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20000)
  charLimit?: number | null;
  /** A1 — create 와 동일 규칙 (첫 답변 저장 시에만 반영, 이후 불변) */
  @IsOptional()
  @IsIn(['manual', 'imported', 'ai_draft'])
  answerOrigin?: 'manual' | 'imported' | 'ai_draft';
}
