import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserDevicesService } from './user-devices.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { UserDevice } from './user-device.entity';

interface AuthUser {
  id: string;
}

/**
 * W2 RN — POST /me/devices (register) · GET /me/devices · DELETE /me/devices/:token
 *
 * Push 알림 대상 관리. 실제 push 발송은 W3 별도 endpoint.
 */
@Controller('me/devices')
export class UserDevicesController {
  constructor(private readonly service: UserDevicesService) {}

  @Post()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async register(
    @CurrentUser() user: AuthUser,
    @Body() dto: RegisterDeviceDto,
  ): Promise<{
    id: string;
    deviceToken: string;
    platform: string;
    createdAt: Date;
    lastActiveAt: Date;
  }> {
    const saved = await this.service.registerDevice(user.id, dto);
    return {
      id: saved.id,
      deviceToken: saved.deviceToken,
      platform: saved.platform,
      createdAt: saved.createdAt,
      lastActiveAt: saved.lastActiveAt,
    };
  }

  @Get()
  async listMine(@CurrentUser() user: AuthUser): Promise<UserDevice[]> {
    return this.service.listMyDevices(user.id);
  }

  /**
   * @param token URL path 로 실제 device token (긴 문자열) 전달.
   *   짧은 alias 를 원하면 record id 로 삭제하는 형태로 변경 가능 (현재는 token 기반).
   */
  @Delete(':token')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('token') token: string,
  ): Promise<void> {
    await this.service.removeDevice(user.id, token);
  }
}
