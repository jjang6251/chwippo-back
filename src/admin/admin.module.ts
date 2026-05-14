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

@Module({
  imports: [
    TypeOrmModule.forFeature([AdminAuditLog, User, Application, Inquiry]),
    UsersModule,
    InquiriesModule,
  ],
  controllers: [AdminController, AdminUsersController],
  providers: [AdminService, AdminUsersService, AdminAuditService],
  exports: [AdminAuditService],
})
export class AdminModule {}
