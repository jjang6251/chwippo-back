import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CompanyResearchMetricsService } from './company-research-metrics.service';

/**
 * PR_B2 Phase 4 — 회사조사 admin metrics endpoint.
 * route 충돌 사전 검증 ✅ — 기존 `/admin/ai-usage/company-research` (별도 path).
 */
@Controller('admin/company-research')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
export class CompanyResearchMetricsController {
  constructor(private readonly service: CompanyResearchMetricsService) {}

  @Get('fill-rate')
  getFillRate() {
    return this.service.getFillRate();
  }

  @Get('cost-trend')
  getCostTrend(@Query('days') days?: string) {
    return this.service.getCostTrend(days ? parseInt(days, 10) : undefined);
  }

  @Get('cache-stats')
  getCacheStats() {
    return this.service.getCacheStats();
  }

  @Get('top-companies')
  getTopCompanies(@Query('limit') limit?: string) {
    return this.service.getTopCompanies(
      limit ? parseInt(limit, 10) : undefined,
    );
  }
}
