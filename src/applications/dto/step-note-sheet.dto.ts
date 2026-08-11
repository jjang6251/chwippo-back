import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * 시트 본문 상한 — 기존 스텝 노트(`UpdateStepDetailDto.notes`)와 **같은 100,000자**.
 * 시트가 기존 노트보다 좁으면 승격 자체가 400 으로 막힌다 (원본을 그대로 못 담는다).
 */
export const SHEET_CONTENT_MAX_CHARS = 100_000;

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
  @MaxLength(SHEET_CONTENT_MAX_CHARS, {
    message: `노트는 ${SHEET_CONTENT_MAX_CHARS.toLocaleString('en-US')}자까지 저장할 수 있어요.`,
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
  @MaxLength(SHEET_CONTENT_MAX_CHARS, {
    message: `노트는 ${SHEET_CONTENT_MAX_CHARS.toLocaleString('en-US')}자까지 저장할 수 있어요.`,
  })
  content?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  orderIndex?: number;
}
