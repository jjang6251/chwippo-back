import {
  IsString,
  IsOptional,
  IsIn,
  IsDateString,
  IsUrl,
  MaxLength,
  IsBoolean,
} from 'class-validator';
import { APPLICATION_TEMPLATE_IDS } from '../application-templates';
import {
  APPLICATION_CREATED_VIA,
  type ApplicationCreatedVia,
} from '../application.entity';

export class CreateApplicationDto {
  @IsString()
  @MaxLength(100)
  companyName: string;

  // 전형 템플릿 id — 미지정/미존재 시 'general'. status=IN_PROGRESS일 때만 초기 스텝에 적용
  @IsOptional()
  @IsString()
  @IsIn(APPLICATION_TEMPLATE_IDS)
  templateId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobTitle?: string;

  @IsOptional()
  @IsString()
  jobCategory?: string;

  @IsOptional()
  @IsIn(['PLANNED', 'IN_PROGRESS'])
  status?: 'PLANNED' | 'IN_PROGRESS';

  @IsOptional()
  @IsDateString()
  deadline?: string;

  @IsOptional()
  @IsUrl()
  jobUrl?: string;

  @IsOptional()
  @IsBoolean()
  needsDetail?: boolean;

  /**
   * 어느 화면에서 만들었는가 — **관측 전용**이라 동작에 영향을 주지 않는다.
   *
   * 클라이언트가 보내는 값이므로 신뢰 경계 밖이다. `IsIn` 으로 **알려진 값만** 받고,
   * 안 보내면 `null` 로 남긴다. 잘못된 값에 400 을 주는 이유는 관측값이라도 조용히
   * 통과시키면 오탐이 데이터에 섞이기 때문이다 — 새 경로를 만들 때 유니온 추가를 강제한다.
   */
  @IsOptional()
  @IsIn(APPLICATION_CREATED_VIA)
  createdVia?: ApplicationCreatedVia;
}
