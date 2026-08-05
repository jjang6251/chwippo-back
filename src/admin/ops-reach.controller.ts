import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  OpsReachService,
  REACH_ROW_LIMIT,
  type OpsReachResponse,
} from './ops-reach.service';

/**
 * `GET /admin/reach` — 도달 현황 (1인 1행 전수 + 단계별 인원 + 데스크탑 축).
 * 5분 캐시는 service 담당.
 *
 * 🔴 응답에 **이메일·kakaoId 를 담지 않는다.** 이 화면은 "누가 어디까지 갔나" 만 필요하고,
 * 개별 신원이 필요하면 `/ops/users/:id` 로 넘어간다. 관측용 화면이 PII 표면을 새로 열 이유가 없다.
 */
@Controller('admin')
@UseGuards(RolesGuard)
@Roles('admin')
export class OpsReachController {
  constructor(private readonly reachService: OpsReachService) {}

  /**
   * `limit` 은 **표시 행 수만** 줄인다 — 단계별 인원·분모는 언제나 전체 기준이다.
   * 잘못된 값(0·음수·문자열·상한 초과)은 400 이 아니라 clamp 한다.
   * 운영자 조회용이라 요청을 튕기는 것보다 안전한 기본값으로 응답하는 편이 낫다.
   */
  @Get('reach')
  getReach(@Query('limit') limit?: string): Promise<OpsReachResponse> {
    const parsed = Number.parseInt(limit ?? '', 10);
    return this.reachService.getReach(
      Number.isFinite(parsed) ? parsed : REACH_ROW_LIMIT,
    );
  }
}
