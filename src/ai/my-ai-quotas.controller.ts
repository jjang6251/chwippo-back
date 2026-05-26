import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { QuotaCheckService } from './quota-check.service';

/**
 * F6 PR 2 Phase 1 — 사용자 자신의 AI quota 사용량·한도 조회.
 *
 * `<AiQuotaChip />` 같은 frontend 컴포넌트가 호출 → feature 별 dayLimit/monthLimit/cooldown 표시.
 * `nextAvailableAt` 가 있으면 카운트다운, day/month 도달 시 disabled + 안내.
 */
@Controller('me/ai-quotas')
@UseGuards(AuthGuard('jwt'))
export class MyAiQuotasController {
  constructor(private readonly quotaCheck: QuotaCheckService) {}

  @Get()
  list(@CurrentUser() user: { id: string }) {
    return this.quotaCheck.getMyQuotas(user.id);
  }
}
