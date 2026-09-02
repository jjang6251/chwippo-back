import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  OpsFeatureUsageService,
  type FeatureUsageResponse,
} from './ops-feature-usage.service';

/**
 * `GET /admin/feature-usage` — 기능 사용 실태 (기능군 통계 · 유저×기능 매트릭스 · 잔존).
 * 5분 캐시는 service 담당.
 *
 * 🔴 **응답에 담기는 것은 id · 닉네임 · 개수 · 날짜뿐**이다. `/ops/card-fields` 와 달리
 * 사용자 식별자가 들어가는 이유는 이 화면의 질문이 *"**누가** 어떤 기능을 쓰나"* 라서다 —
 * 매트릭스에서 사람이 사라지면 화면이 답하려는 질문 자체가 없어진다. 대신 콘텐츠
 * (노트 본문·메모 내용·자소서 답변)는 집계 재료로만 쓰고 **한 글자도 나가지 않는다.**
 *
 * 자르는 파라미터가 없는 이유 — `OpsCardFieldsController` 와 같다. 전수 집계 하나뿐이라
 * 자를 축이 없고, 기간으로 자르면 작은 N 에서 해석이 불가능해진다.
 */
@Controller('admin')
@UseGuards(RolesGuard)
@Roles('admin')
export class OpsFeatureUsageController {
  constructor(private readonly featureUsageService: OpsFeatureUsageService) {}

  /**
   * `?refresh=1` — 5분 캐시를 건너뛰고 다시 집계한다.
   *
   * `'0'`·`'false'` 를 참으로 읽지 않는다 — 그렇게 만들면 끄려고 넣은 값이 켜는 값이 된다
   * (`OpsCardFieldsController` 와 같은 규칙).
   */
  @Get('feature-usage')
  getFeatureUsage(
    @Query('refresh') refresh?: string,
  ): Promise<FeatureUsageResponse> {
    const force =
      refresh != null &&
      refresh !== '' &&
      refresh !== '0' &&
      refresh !== 'false';
    return this.featureUsageService.getFeatureUsage(force);
  }
}
