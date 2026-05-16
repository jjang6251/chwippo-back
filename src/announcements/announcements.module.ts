import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Announcement } from './announcement.entity';
import { AnnouncementsService } from './announcements.service';
import { AnnouncementsController } from './announcements.controller';
import { AdminAnnouncementsController } from './admin-announcements.controller';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [TypeOrmModule.forFeature([Announcement]), AdminModule],
  providers: [AnnouncementsService],
  controllers: [AnnouncementsController, AdminAnnouncementsController],
})
export class AnnouncementsModule {}
