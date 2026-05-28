import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CompanyResearchService } from './company-research.service';

class OptOutDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  companyName: string;
}

/**
 * F6 PR 2 Phase 4 단계 B — 회사 조사 admin endpoints.
 *
 * - GET `/admin/ai-usage/company-research/top?limit=20` — 회사별 hit ranking (opt_out 제외)
 * - POST `/admin/ai-usage/company-research/opt-out` — 회사 측 삭제 요청 처리 (24시간 SLA)
 *   body: `{ companyName }` → 해당 회사 모든 row opt_out=true + aiResearch 비움
 */
@Controller('admin/ai-usage/company-research')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminCompanyResearchController {
  constructor(private readonly research: CompanyResearchService) {}

  @Get('top')
  topCompanies(@Query('limit') limit?: string) {
    return this.research.getTopCompanies(limit ? parseInt(limit, 10) : 20);
  }

  @Post('opt-out')
  optOut(@CurrentUser() admin: { id: string }, @Body() dto: OptOutDto) {
    return this.research.optOut(admin.id, dto.companyName);
  }
}
