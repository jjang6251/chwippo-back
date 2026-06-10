import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminInquiriesService } from './admin-inquiries.service';

/**
 * PR_B2 Phase 4 — admin 상단 종 아이콘의 4 badge count.
 * route 충돌 사전 검증 ✅ — `/admin/notifications/*` 신규.
 */
@Controller('admin/notifications')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
export class AdminNotificationsController {
  constructor(private readonly inquiriesService: AdminInquiriesService) {}

  @Get('badges')
  getBadges() {
    return this.inquiriesService.getNotificationBadges();
  }
}
