import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CompanyResearchStatusService } from './company-research-status.service';
import { UnifiedCompanyResearchDto } from './dto/unified-company-research.dto';

/**
 * feature-research-admin — 회사 조사 현황 admin 조회 (읽기 전용).
 * summary(커버리지·버전·avgFillRate) + unified(조사 캐시 ∪ 지원 카드 통합 목록).
 */
@Controller('admin/company-research')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
export class CompanyResearchStatusController {
  constructor(private readonly service: CompanyResearchStatusService) {}

  @Get('summary')
  getSummary() {
    return this.service.getSummary();
  }

  @Get('unified')
  getUnified(@Query() query: UnifiedCompanyResearchDto) {
    return this.service.getUnified(query);
  }
}
