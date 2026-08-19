import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

/**
 * 선택 영역 액션 5종.
 *
 * `free` 는 선택이 있을 때의 자유 지시고, **선택이 없으면 같은 값이 「생성」** 이 된다
 * (분기는 `selectionMd` 유무로 서비스가 판정한다). Phase 2 의 문서 전체 액션은
 * 이 배열에 값을 더하는 것으로 붙는다 — 그래서 액션은 문자열 enum 한 곳에만 둔다.
 */
export const NOTE_AI_ACTIONS = [
  'easy',
  'concise',
  'table',
  'qa_toggle',
  'free',
] as const;

export type NoteAiAction = (typeof NOTE_AI_ACTIONS)[number];

/**
 * 입력 상한. 숫자를 문구에 실어 400 으로 되돌린다 (무엇을 줄여야 하는지 알게).
 *
 * `SELECTION_MAX` 6,000자는 모델 input cap(8,000 토큰)에서 역산한 값이다 —
 * 한국어 6,000자 ≈ 4,000 토큰 + 히스토리 3턴 + 시스템 프롬프트가 얹혀도 여유가 남는다.
 */
export const NOTE_AI_LIMITS = {
  SELECTION_MAX: 6_000,
  INSTRUCTION_MAX: 500,
  HISTORY_MAX_ITEMS: 6,
  HISTORY_ITEM_MAX: 4_000,
  /**
   * 프롬프트에 싣는 **최근 턴 수**. 초과분은 400 이 아니라 **조용히 버린다** —
   * 히스토리는 클라이언트가 들고 다니는 값이라(D5) 길다고 요청을 실패시키면
   * 사용자는 원인을 알 수 없고 패널을 닫는 것 말고 복구 방법이 없다.
   */
  HISTORY_PROMPT_TURNS: 3,
} as const;

export class NoteAiHistoryItemDto {
  /** 'user' = 사용자가 보낸 지시 · 'result' = 그때 AI 가 돌려준 마크다운 */
  @IsIn(['user', 'result'])
  role: 'user' | 'result';

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  text: string;
}

/**
 * 항목별 길이 판정을 **배열 레벨**에서 한다.
 *
 * 중첩(`@ValidateNested` 안의 `@MaxLength`) 으로 두면 전역 `ValidationPipe` 의
 * exceptionFactory 가 자식 제약을 못 읽고 `"history"` 한 단어만 400 문구로 내보낸다 —
 * 사용자는 무엇을 얼마나 줄여야 하는지 알 수 없다. 숫자를 문구에 실으려면 여기여야 한다.
 */
@ValidatorConstraint({ name: 'noteAiHistoryTextCap', async: false })
export class NoteAiHistoryTextCapValidator implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    // 배열 여부·항목 수는 @IsArray·@ArrayMaxSize 가 본다
    if (!Array.isArray(value)) return true;
    return value.every((raw: unknown) => {
      const item = (
        typeof raw === 'object' && raw !== null ? raw : {}
      ) as Record<string, unknown>;
      return (
        typeof item.text !== 'string' ||
        item.text.length <= NOTE_AI_LIMITS.HISTORY_ITEM_MAX
      );
    });
  }

  defaultMessage(): string {
    return `대화 내용이 너무 길어요 (항목당 ${NOTE_AI_LIMITS.HISTORY_ITEM_MAX.toLocaleString('en-US')}자 이하).`;
  }
}

/**
 * `POST /study-notes/:id/ai-action` · `POST /applications/:id/steps/:stepId/ai-action`
 *
 * 🔴 **히스토리는 신뢰 경계 밖이다.** 서버는 대화를 저장하지 않으므로(D6) 이 값이
 * 실제로 오갔던 대화인지 확인할 방법이 없다 — 선택 원문과 똑같이 코드펜스로 격리해
 * 자료로만 취급한다.
 *
 * 전부 **trim 후** 판정한다. 공백만 붙여넣은 선택이 6,000자를 넘어 400 이 나거나,
 * 반대로 공백만 있는 지시가 통과해 빈 프롬프트가 나가는 걸 둘 다 막는다.
 */
export class NoteAiActionDto {
  @IsIn(NOTE_AI_ACTIONS, {
    message: `action 은 ${NOTE_AI_ACTIONS.join(' · ')} 중 하나여야 해요.`,
  })
  action: NoteAiAction;

  /** 없으면 「무선택 생성」 분기 (이때 `instruction` 이 필수가 된다) */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(NOTE_AI_LIMITS.SELECTION_MAX, {
    message: `선택한 내용이 너무 길어요 (${NOTE_AI_LIMITS.SELECTION_MAX.toLocaleString('en-US')}자 이하).`,
  })
  selectionMd?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(NOTE_AI_LIMITS.INSTRUCTION_MAX, {
    message: `지시는 ${NOTE_AI_LIMITS.INSTRUCTION_MAX}자 이하로 입력해 주세요.`,
  })
  instruction?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(NOTE_AI_LIMITS.HISTORY_MAX_ITEMS, {
    message: `대화 기록은 ${NOTE_AI_LIMITS.HISTORY_MAX_ITEMS}개까지만 보낼 수 있어요.`,
  })
  @Validate(NoteAiHistoryTextCapValidator)
  @ValidateNested({ each: true })
  @Type(() => NoteAiHistoryItemDto)
  history?: NoteAiHistoryItemDto[];
}
