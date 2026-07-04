import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserDevice } from './user-device.entity';
import { UserDevicesController } from './user-devices.controller';
import { UserDevicesService } from './user-devices.service';
import { DiscordNotifier } from '../common/discord-notifier';

@Module({
  imports: [TypeOrmModule.forFeature([UserDevice])],
  controllers: [UserDevicesController],
  providers: [UserDevicesService, DiscordNotifier],
  exports: [UserDevicesService],
})
export class UserDevicesModule {}
