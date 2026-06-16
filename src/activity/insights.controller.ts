import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { InsightsService } from './insights.service';

interface AuthUser {
  id: string;
  role: string;
}

/**
 * F6 PR 1 Phase 3c — `GET /activity/insights`.
 * 사용자의 강점·자소서 소재·heatmap·trend 단일 응답 (5분 cache).
 * 프론트 sub-tab 전환 시 별도 API 호출 불필요.
 */
@Controller('activity/insights')
export class InsightsController {
  constructor(private readonly service: InsightsService) {}

  @Get()
  getInsights(@CurrentUser() user: AuthUser) {
    return this.service.getInsights(user.id);
  }
}
