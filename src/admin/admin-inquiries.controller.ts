import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminInquiriesService } from './admin-inquiries.service';
import { AssignInquiryDto } from './dto/assign-inquiry.dto';
import { SetPriorityDto } from './dto/set-priority.dto';
import { SetSlaDto } from './dto/set-sla.dto';
import { getAuditCtx } from './utils/audit-ctx';

/**
 * PR_B2 Phase 4 — admin inquiry 처리 endpoint.
 *
 * route 충돌 회피 — 기존 AdminController 가 `/admin/inquiries/:id` 차지 →
 * sub-static path 도 `:id="admins"` 로 잡힘 (uuid parse 실패 500).
 * 신규 base path `/admin/inquiry-ops` 로 분리.
 */
@Controller('admin/inquiry-ops')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
export class AdminInquiriesController {
  constructor(private readonly service: AdminInquiriesService) {}

  @Get('admins')
  listAdmins() {
    return this.service.listAdmins();
  }

  @Get('sla-overdue')
  getSlaOverdue() {
    return this.service.getSlaOverdue();
  }

  @Patch(':id/assign')
  assign(
    @CurrentUser() admin: { id: string },
    @Param('id') id: string,
    @Body() dto: AssignInquiryDto,
    @Req() req: Request,
  ) {
    return this.service.assignInquiry(admin.id, id, dto, getAuditCtx(req));
  }

  @Patch(':id/priority')
  setPriority(
    @CurrentUser() admin: { id: string },
    @Param('id') id: string,
    @Body() dto: SetPriorityDto,
    @Req() req: Request,
  ) {
    return this.service.setPriority(admin.id, id, dto, getAuditCtx(req));
  }

  @Patch(':id/sla')
  setSla(
    @CurrentUser() admin: { id: string },
    @Param('id') id: string,
    @Body() dto: SetSlaDto,
    @Req() req: Request,
  ) {
    return this.service.setSla(admin.id, id, dto, getAuditCtx(req));
  }
}
