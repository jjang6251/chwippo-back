import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** 시트 이름과 같은 방어선 — 실제 1~50 판정은 서비스가 trim 후 한다 */
const NAME_DEFENSIVE_MAX = 200;

export class CreateStudyNoteFolderDto {
  @IsString()
  @MaxLength(NAME_DEFENSIVE_MAX)
  name: string;

  /** 2차 중첩 예약. 1차는 서비스가 1단을 넘는 조합을 전부 400 으로 막는다 */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  parentId?: string | null;
}

export class UpdateStudyNoteFolderDto {
  @IsOptional()
  @IsString()
  @MaxLength(NAME_DEFENSIVE_MAX)
  name?: string;

  /** `null` 명시 = 최상위로 올린다 */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  parentId?: string | null;
}
