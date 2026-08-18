import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * 본문 상한 — 준비 노트 시트(`SHEET_CONTENT_MAX_CHARS`)와 **같은 100,000자**.
 * 두 노트북 사이를 오가며 복사하는 사용자가 한쪽에서만 막히면 이유를 알 수 없다.
 */
export const NOTE_CONTENT_MAX_CHARS = 100_000;

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
  @MaxLength(NOTE_CONTENT_MAX_CHARS, {
    message: `노트는 ${NOTE_CONTENT_MAX_CHARS.toLocaleString('en-US')}자까지 저장할 수 있어요.`,
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
  @MaxLength(NOTE_CONTENT_MAX_CHARS, {
    message: `노트는 ${NOTE_CONTENT_MAX_CHARS.toLocaleString('en-US')}자까지 저장할 수 있어요.`,
  })
  content?: string;
}
