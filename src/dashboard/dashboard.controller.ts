import { Controller, Get } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';

interface AuthUser {
  id: string;
}

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

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
}
