import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { UsersModule } from '../users/users.module';
import { InquiriesModule } from '../inquiries/inquiries.module';

@Module({
  imports: [UsersModule, InquiriesModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
