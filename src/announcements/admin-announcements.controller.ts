import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AnnouncementsService } from './announcements.service';
import { AdminAuditService } from '../admin/admin-audit.service';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';

interface AuthUser {
  id: string;
}

@Controller('admin/announcements')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminAnnouncementsController {
  constructor(
    private readonly service: AnnouncementsService,
    private readonly auditService: AdminAuditService,
  ) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Post()
  async create(
    @CurrentUser() admin: AuthUser,
    @Body() dto: CreateAnnouncementDto,
  ) {
    const announcement = await this.service.create(dto);
    await this.auditService.log(
      admin.id,
      'publish_announcement',
      'announcement',
      announcement.id,
      { title: dto.title, type: dto.type, active: dto.active },
    );
    return announcement;
  }

  @Patch(':id')
  async update(
    @CurrentUser() admin: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateAnnouncementDto,
  ) {
    const announcement = await this.service.update(id, dto);
    await this.auditService.log(
      admin.id,
      'update_announcement',
      'announcement',
      id,
      { changed: Object.keys(dto) },
    );
    return announcement;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() admin: AuthUser, @Param('id') id: string) {
    await this.service.remove(id);
    await this.auditService.log(
      admin.id,
      'delete_announcement',
      'announcement',
      id,
      {},
    );
  }
}
