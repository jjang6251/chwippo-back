import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { DashboardService } from './dashboard.service';
import { StreakService } from './streak.service';
import { GrowthService } from './growth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';

interface AuthUser {
  id: string;
}

@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly streakService: StreakService,
    private readonly growthService: GrowthService,
  ) {}

  @Get('stats')
  getStats(@CurrentUser() user: AuthUser) {
    return this.dashboardService.getStats(user.id);
  }

  @Get('dday')
  getDdayList(@CurrentUser() user: AuthUser) {
    return this.dashboardService.getDdayList(user.id);
  }

  @Get('interview-review')
  getInterviewReview(@CurrentUser() user: AuthUser) {
    return this.dashboardService.getYesterdayInterviews(user.id);
  }

  /**
   * W3 — 통합 streak + 365일 heatmap + status 분포.
   * 5분 in-memory 캐시 — polling 차단. Rate limit 30 rpm.
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('streak')
  getStreak(@CurrentUser() user: AuthUser) {
    return this.streakService.getDashboardStreak(user.id);
  }

  /**
   * 회고=성장 페이지 Phase A — 이번 달 vs 지난 달 활동량 + 개인 funnel.
   * 5분 in-memory 캐시. Rate limit 30 rpm (streak 와 동일).
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('growth-metrics')
  getGrowthMetrics(@CurrentUser() user: AuthUser) {
    return this.growthService.getGrowthMetrics(user.id);
  }
}
