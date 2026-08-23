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

  /**
   * 전체 내보내기 — 같은 필터·정렬의 **전 범위** (page/limit 무시).
   * DTO 는 unified 와 공유한다 — 두 응답의 필터·정렬 화이트리스트가 갈라지면
   * "화면과 내보낸 파일이 다른" 상태가 생긴다.
   */
  @Get('export')
  getExport(@Query() query: UnifiedCompanyResearchDto) {
    return this.service.getExport(query);
  }
}
