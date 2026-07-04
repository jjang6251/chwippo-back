import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { envValidationSchema } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { ApplicationsModule } from './applications/applications.module';
import { CompaniesModule } from './companies/companies.module';
import { SchoolsModule } from './schools/schools.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MyinfoModule } from './myinfo/myinfo.module';
import { FilesModule } from './files/files.module';
import { UsersModule } from './users/users.module';
import { InquiriesModule } from './inquiries/inquiries.module';
import { AdminModule } from './admin/admin.module';
import { SuspendedGuard } from './common/guards/suspended.guard';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './users/user.entity';
import { CalendarModule } from './calendar/calendar.module';
import { AnnouncementsModule } from './announcements/announcements.module';
import { ActivityModule } from './activity/activity.module';
import { AiModule } from './ai/ai.module';
import { InterviewPrepModule } from './interview-prep/interview-prep.module';
import { AiContentReportsModule } from './ai-content-reports/ai-content-reports.module';
import { UserDevicesModule } from './devices/user-devices.module';
import { NotificationsModule } from './notifications/notifications.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    // F6 PR 2 Phase 5.4 — ThresholdCheckService cron (10분)
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuthModule,
    ApplicationsModule,
    CompaniesModule,
    SchoolsModule,
    DashboardModule,
    MyinfoModule,
    FilesModule,
    UsersModule,
    InquiriesModule,
    AdminModule,
    CalendarModule,
    AnnouncementsModule,
    ActivityModule,
    AiModule,
    InterviewPrepModule,
    AiContentReportsModule,
    UserDevicesModule,
    NotificationsModule,
    TypeOrmModule.forFeature([User]), // PR_B2 Phase 1 — SuspendedGuard 의 User repo 의존성
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SuspendedGuard }, // PR_B2 Phase 1 — Q25 SuspendedModal bypass 방어
  ],
})
export class AppModule {}
