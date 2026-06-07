import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AiUsageService } from './ai-usage.service';
import type { Period } from './ai-usage.service';

/**
 * PR_B2 Phase 2 — admin AI 사용량 dashboard endpoints (Q14).
 *
 * 모든 endpoint 는 admin role 만 (RolesGuard + @Roles('admin')).
 * period query — day | week | month | quarter | year.
 */
@Controller('admin/ai-usage')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
export class AiUsageController {
  constructor(private readonly aiUsage: AiUsageService) {}

  @Get()
  getMetrics(
    @Query('period') period: Period = 'day',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.aiUsage.getUsageMetrics(period, from, to);
  }

  @Get('top-users')
  getTopUsers(
    @Query('period') period: Period = 'day',
    @Query('limit') limitStr?: string,
  ) {
    const limit = limitStr ? parseInt(limitStr, 10) : 20;
    return this.aiUsage.getTopUsers(period, limit);
  }

  @Get('by-feature')
  getByFeature(@Query('period') period: Period = 'day') {
    return this.aiUsage.getByFeature(period);
  }

  @Get('by-model')
  getByModel(@Query('period') period: Period = 'day') {
    return this.aiUsage.getByModel(period);
  }
}
