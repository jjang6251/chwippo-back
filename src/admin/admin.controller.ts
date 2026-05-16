import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminAuditService } from './admin-audit.service';
import { InquiriesService } from '../inquiries/inquiries.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IsString, MinLength, MaxLength } from 'class-validator';

interface AuthUser {
  id: string;
}

class AdminCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content: string;
}

@Controller('admin')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly inquiriesService: InquiriesService,
    private readonly auditService: AdminAuditService,
  ) {}

  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  @Get('analytics')
  getAnalytics(@Query('days') days?: string) {
    const d = Math.min(Math.max(parseInt(days ?? '30') || 30, 7), 90);
    return this.adminService.getAnalytics(d);
  }

  @Get('inquiries')
  getInquiries(
    @Query('status') status?: string,
    @Query('category') category?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.inquiriesService.findAll({
      status,
      category,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 30,
    });
  }

  @Get('inquiries/:id')
  getInquiry(@Param('id') id: string) {
    return this.inquiriesService.findOneAdmin(id);
  }

  @Post('inquiries/:id/comments')
  async addComment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AdminCommentDto,
  ) {
    const comment = await this.inquiriesService.addAdminComment(
      id,
      user.id,
      dto.content,
    );
    // 본문은 audit log에 평문 저장하지 않음 (privacy) — 길이만 기록
    await this.auditService.log(user.id, 'reply_inquiry', 'inquiry', id, {
      contentLength: dto.content.length,
    });
    return comment;
  }

  @Patch('inquiries/:id/close')
  async closeInquiry(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const result = await this.inquiriesService.closeInquiry(id);
    await this.auditService.log(user.id, 'close_inquiry', 'inquiry', id, {});
    return result;
  }
}
