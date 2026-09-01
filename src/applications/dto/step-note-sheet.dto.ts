import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { TiptapTextMaxLength } from '../../common/decorators/tiptap-text-max-length.decorator';

/**
 * 시트 본문 상한 — 기존 스텝 노트(`UpdateStepDetailDto.notes`)와 **같은 100,000자**.
 * 시트가 기존 노트보다 좁으면 승격 자체가 400 으로 막힌다 (원본을 그대로 못 담는다).
 *
 * 🔴 **이 숫자는 「본문 글자수」다 — JSON 길이가 아니다** (2026-09-02 실사고).
 * 저장 값은 `JSON.stringify(tiptap doc)` 이라 구조(헤딩·표·인용)가 많을수록 문자열이
 * 부푼다. 이 상한을 JSON 길이에 걸어 놓았더니, 화면 카운터에 「56,281 / 100,000」 이
 * 떠 있는 노트가 JSON 110,000자로 400 을 맞았다. 그래서 판정은 `@TiptapTextMaxLength` 가 한다.
 */
export const SHEET_CONTENT_MAX_CHARS = 100_000;

/**
 * 방어용 **원문 상한** — 사용자에게 광고하는 한도가 아니라 JSON 폭탄 차단선이다.
 * 위 상한이 텍스트만 세므로, 텍스트 0자에 노드 수십만 개인 payload 를 파싱·저장하는 길이
 * 열린다. 한글 위주 100,000자 노트의 실측 JSON(구조 포함)이 넉넉히 들어가는 값으로 잡는다.
 */
const SHEET_CONTENT_RAW_MAX_CHARS = 400_000;

/** 두 층이 같은 문구를 쓴다 — 사용자에게는 「노트가 너무 길다」 하나의 사실이다 */
const SHEET_CONTENT_MESSAGE = `노트는 ${SHEET_CONTENT_MAX_CHARS.toLocaleString('en-US')}자까지 저장할 수 있어요.`;

/**
 * DTO 단 이름 상한은 사용자 규칙(1~50)이 **아니라** 방어선이다.
 * 실제 판정은 서비스가 trim 후 1~50 으로 한다 — 붙여넣은 이름 끝의 공백 때문에
 * 멀쩡한 50자가 막히면 사용자는 원인을 알 수 없다. 여기서는 터무니없는 크기만 자른다.
 */
const NAME_DEFENSIVE_MAX = 200;

export class CreateStepNoteSheetDto {
  @IsString()
  @MaxLength(NAME_DEFENSIVE_MAX)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(SHEET_CONTENT_RAW_MAX_CHARS, { message: SHEET_CONTENT_MESSAGE })
  @TiptapTextMaxLength(SHEET_CONTENT_MAX_CHARS, {
    message: SHEET_CONTENT_MESSAGE,
  })
  content?: string;

  /**
   * 🔴 승격 멱등 가드 — true 면 **시트가 0장일 때만** 만든다.
   * 이미 있으면 첫 시트를 그대로 돌려준다(200). 더블 세이브·멀티탭이 같은
   * "기존 노트 → 첫 시트" 승격을 두 번 보내도 시트가 2장이 되지 않는다.
   */
  @IsOptional()
  @IsBoolean()
  ifEmpty?: boolean;
}

export class UpdateStepNoteSheetDto {
  @IsOptional()
  @IsString()
  @MaxLength(NAME_DEFENSIVE_MAX)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(SHEET_CONTENT_RAW_MAX_CHARS, { message: SHEET_CONTENT_MESSAGE })
  @TiptapTextMaxLength(SHEET_CONTENT_MAX_CHARS, {
    message: SHEET_CONTENT_MESSAGE,
  })
  content?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  orderIndex?: number;
}
