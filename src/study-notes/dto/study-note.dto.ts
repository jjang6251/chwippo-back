import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { TiptapTextMaxLength } from '../../common/decorators/tiptap-text-max-length.decorator';

/**
 * 본문 상한 — 준비 노트 시트(`SHEET_CONTENT_MAX_CHARS`)와 **같은 100,000자**.
 * 두 노트북 사이를 오가며 복사하는 사용자가 한쪽에서만 막히면 이유를 알 수 없다.
 *
 * 🔴 **이 숫자는 「본문 글자수」다 — JSON 길이가 아니다** (2026-09-02 실사고).
 * 저장 값은 `JSON.stringify(tiptap doc)` 이라 구조(헤딩·표·인용)가 많을수록 문자열이
 * 부푼다. 이 상한을 JSON 길이에 걸어 놓았더니, 화면 카운터에 「56,281 / 100,000」 이
 * 떠 있는 노트가 JSON 110,000자로 400 을 맞았다 — 사용자는 여유가 있다고 보면서
 * 저장을 못 한다. 그래서 판정은 `@TiptapTextMaxLength` 가 한다.
 */
export const NOTE_CONTENT_MAX_CHARS = 100_000;

/**
 * 방어용 **원문 상한** — 사용자에게 광고하는 한도가 아니라 JSON 폭탄 차단선이다.
 * 위 상한이 텍스트만 세므로, 텍스트 0자에 노드 수십만 개인 payload 를 파싱·저장하는 길이
 * 열린다. 한글 위주 100,000자 노트의 실측 JSON(구조 포함)이 넉넉히 들어가는 값으로 잡는다.
 */
const NOTE_CONTENT_RAW_MAX_CHARS = 400_000;

/** 두 층이 같은 문구를 쓴다 — 사용자에게는 「노트가 너무 길다」 하나의 사실이다 */
const NOTE_CONTENT_MESSAGE = `노트는 ${NOTE_CONTENT_MAX_CHARS.toLocaleString('en-US')}자까지 저장할 수 있어요.`;

/**
 * DTO 단 제목 상한은 사용자 규칙(0~100)이 **아니라** 방어선이다.
 * 실제 판정은 서비스가 trim 후 0~100 으로 한다 — 붙여넣은 제목 끝의 공백 때문에
 * 멀쩡한 100자가 막히면 사용자는 원인을 알 수 없다.
 */
const TITLE_DEFENSIVE_MAX = 300;

export class CreateStudyNoteDto {
  /** 미전달 = 빈 제목('') 로 만든다 — 노션식 즉시 생성 */
  @IsOptional()
  @IsString()
  @MaxLength(TITLE_DEFENSIVE_MAX)
  title?: string;

  /** null = 미분류. 미전달도 미분류 */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  folderId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(NOTE_CONTENT_RAW_MAX_CHARS, { message: NOTE_CONTENT_MESSAGE })
  @TiptapTextMaxLength(NOTE_CONTENT_MAX_CHARS, {
    message: NOTE_CONTENT_MESSAGE,
  })
  content?: string;
}

export class UpdateStudyNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(TITLE_DEFENSIVE_MAX)
  title?: string;

  /**
   * `null` 을 명시하면 미분류로 이동한다. 미전달이면 폴더는 그대로 —
   * 자동저장이 본문만 보내는 흐름이라 이 둘을 구분하지 못하면 저장할 때마다 폴더가 풀린다.
   */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  folderId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(NOTE_CONTENT_RAW_MAX_CHARS, { message: NOTE_CONTENT_MESSAGE })
  @TiptapTextMaxLength(NOTE_CONTENT_MAX_CHARS, {
    message: NOTE_CONTENT_MESSAGE,
  })
  content?: string;
}
