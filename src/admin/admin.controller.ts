import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { InquiriesService } from '../inquiries/inquiries.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UpdateInquiryDto } from './dto/update-inquiry.dto';

@Controller('admin')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly inquiriesService: InquiriesService,
  ) {}

  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  @Get('inquiries')
  getInquiries(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.inquiriesService.findAll({
      status,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
    });
  }

  @Patch('inquiries/:id')
  updateInquiry(@Param('id') id: string, @Body() dto: UpdateInquiryDto) {
    return this.inquiriesService.updateStatus(id, dto.status, dto.adminReply);
  }
}
