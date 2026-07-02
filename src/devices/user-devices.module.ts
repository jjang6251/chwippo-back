import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserDevice } from './user-device.entity';
import { UserDevicesController } from './user-devices.controller';
import { UserDevicesService } from './user-devices.service';
import { PushCandidateService } from './push-candidate.service';
import { PushNotificationCron } from './push-notification.cron';
import { ApplicationStep } from '../applications/application-step.entity';
import { DiscordNotifier } from '../common/discord-notifier';

@Module({
  imports: [TypeOrmModule.forFeature([UserDevice, ApplicationStep])],
  controllers: [UserDevicesController],
  providers: [
    UserDevicesService,
    PushCandidateService,
    PushNotificationCron,
    DiscordNotifier,
  ],
  exports: [UserDevicesService, PushCandidateService],
})
export class UserDevicesModule {}
