import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuditLog } from './admin-audit-log.entity';
import { User } from '../users/user.entity';
import { Application } from '../applications/application.entity';
import { Inquiry } from '../inquiries/inquiry.entity';
import { UsersModule } from '../users/users.module';
import { InquiriesModule } from '../inquiries/inquiries.module';
import { MyinfoModule } from '../myinfo/myinfo.module';
import { Cert } from '../myinfo/entities/cert.entity';
import { Award } from '../myinfo/entities/award.entity';
import { LanguageCert } from '../myinfo/entities/language-cert.entity';
import { Experience } from '../myinfo/entities/experience.entity';
import { CoverletterCustom } from '../myinfo/entities/coverletter-custom.entity';
import { Document } from '../myinfo/entities/document.entity';
import { Education } from '../myinfo/entities/education.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AdminAuditLog,
      User,
      Application,
      Inquiry,
      Cert,
      Award,
      LanguageCert,
      Experience,
      CoverletterCustom,
      Document,
      Education,
    ]),
    UsersModule,
    InquiriesModule,
    MyinfoModule,
  ],
  controllers: [AdminController, AdminUsersController],
  providers: [AdminService, AdminUsersService, AdminAuditService],
  exports: [AdminAuditService],
})
export class AdminModule {}
