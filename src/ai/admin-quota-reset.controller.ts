import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsUUID } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminQuotaResetService } from './admin-quota-reset.service';

class ResetAiQuotaInputDto {
  @IsOptional()
  @IsUUID()
  userId?: string;
}

/** F6 PR 2 Phase 5.6.9 — admin AI quota reset endpoint. memory `feedback_admin_quota_control` */
@Controller('admin/ai-quota-reset')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminQuotaResetController {
  constructor(private readonly service: AdminQuotaResetService) {}

  @Post()
  reset(
    @CurrentUser() admin: { id: string },
    @Body() dto: ResetAiQuotaInputDto,
  ) {
    return this.service.reset(admin.id, dto);
  }
}
