import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Notification } from './notification.entity';
import { NotificationLog } from './notification-log.entity';
import { User } from '../users/user.entity';
import { UserDevice } from '../devices/user-device.entity';
import { AuthModule } from '../auth/auth.module';
import { ApplicationStep } from '../applications/application-step.entity';
import { ExamSchedule } from '../myinfo/entities/exam-schedule.entity';
import { DailyNote } from '../calendar/daily-note.entity';
import { NotificationsService } from './notifications.service';
import { AlarmConfigService } from './alarm-config.service';
import { PushService } from './push.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { BriefingService } from './briefing.service';
import { DeadlineUrgentService } from './deadline-urgent.service';
import { ImminentReminderService } from './imminent-reminder.service';
import { NotificationCron } from './notification.cron';
import { NotificationsController } from './notifications.controller';
import { AlarmConfigController } from './alarm-config.controller';
import { AdminNotifyService } from './admin-notify.service';

/**
 * 알림 시스템 — 인앱 센터 + 설정 + push 발송 (브리핑·마감 긴급) + admin 즉시 통지.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Notification,
      NotificationLog,
      User,
      UserDevice,
      ApplicationStep,
      ExamSchedule,
      DailyNote,
    ]),
    // 푸시-세션 분리: NotificationDispatchService 가 AuthService.hasValidSession 사용
    AuthModule,
  ],
  controllers: [NotificationsController, AlarmConfigController],
  providers: [
    NotificationsService,
    AlarmConfigService,
    PushService,
    NotificationDispatchService,
    BriefingService,
    DeadlineUrgentService,
    ImminentReminderService,
    NotificationCron,
    AdminNotifyService,
  ],
  exports: [NotificationsService, AdminNotifyService],
})
export class NotificationsModule {}
