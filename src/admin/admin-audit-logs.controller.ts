import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminAuditLogsService } from './admin-audit-logs.service';

/**
 * PR_B2 Phase 4 — admin audit log 검색 endpoint.
 * route 충돌 사전 검증 ✅ — `/admin/audit-logs` 신규.
 */
@Controller('admin/audit-logs')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
export class AdminAuditLogsController {
  constructor(private readonly service: AdminAuditLogsService) {}

  @Get()
  search(
    @Query('action') action?: string,
    @Query('adminId') adminId?: string,
    @Query('targetId') targetId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.search({
      action,
      adminId,
      targetId,
      from,
      to,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
