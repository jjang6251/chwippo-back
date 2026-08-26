import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  OpsCardFieldsService,
  type OpsCardFieldsResponse,
} from './ops-card-fields.service';

/**
 * `GET /admin/card-fields` — 카드 입력 실태 (채움률 · 어휘 · 표기 흔들림 · 회사명 매칭).
 * 5분 캐시는 service 담당.
 *
 * 🔴 **응답에 사용자 식별자를 담지 않는다.** 이 화면은 "무엇이 얼마나 채워지나" 만 필요하고,
 * 개별 신원이 필요하면 `/ops/users/:id` 로 넘어간다 (`OpsReachController` 와 같은 판단).
 * 관측용 화면이 PII 표면을 새로 열 이유가 없다.
 *
 * 자르는 파라미터가 없는 이유 — 이 지표는 **전수 집계 하나**뿐이라 자를 축이 없다.
 * 기간으로 자르면 분모가 쪼개져 작은 N 에서 해석이 불가능해진다.
 */
@Controller('admin')
@UseGuards(RolesGuard)
@Roles('admin')
export class OpsCardFieldsController {
  constructor(private readonly cardFieldsService: OpsCardFieldsService) {}

  /**
   * `?refresh=1` — 5분 캐시를 건너뛰고 다시 집계한다.
   *
   * 존재 이유는 service 주석 참조: 탈출구 없는 캐시가 「값이 안 변했다」와 「새로 안 읽었다」를
   * 구분 불가능하게 만들었다. **값이 없으면 평소처럼 캐시를 쓴다** — 새로고침이 기본이 되면
   * 캐시가 무의미해진다.
   *
   * `'0'`·`'false'` 를 참으로 읽지 않는다 — 그렇게 만들면 끄려고 넣은 값이 켜는 값이 된다.
   */
  @Get('card-fields')
  getCardFields(
    @Query('refresh') refresh?: string,
  ): Promise<OpsCardFieldsResponse> {
    const force =
      refresh != null &&
      refresh !== '' &&
      refresh !== '0' &&
      refresh !== 'false';
    return this.cardFieldsService.getCardFields(force);
  }
}
