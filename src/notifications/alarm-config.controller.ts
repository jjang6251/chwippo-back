import { Body, Controller, Get, HttpCode, Patch } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AlarmConfigService } from './alarm-config.service';
import { UpdateAlarmConfigDto } from './dto/update-alarm-config.dto';
import { AlarmPromptDto } from './dto/alarm-prompt.dto';
import type { AlarmConfig } from './notification.types';

interface AuthUser {
  id: string;
}

/**
 * 알림 설정.
 *   GET   /me/alarm-config     설정 조회 (NULL → 기본값 merge)
 *   PATCH /me/alarm-config     부분 update
 *   PATCH /me/alarm-prompt     soft-ask 응답 / OS 권한 상태 동기화
 */
@Controller('me')
export class AlarmConfigController {
  constructor(private readonly service: AlarmConfigService) {}

  @Get('alarm-config')
  async get(@CurrentUser() user: AuthUser): Promise<AlarmConfig> {
    return this.service.get(user.id);
  }

  @Patch('alarm-config')
  async update(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateAlarmConfigDto,
  ): Promise<AlarmConfig> {
    return this.service.update(user.id, dto);
  }

  @Patch('alarm-prompt')
  @HttpCode(204)
  async recordPrompt(
    @CurrentUser() user: AuthUser,
    @Body() dto: AlarmPromptDto,
  ): Promise<void> {
    await this.service.recordPrompt(user.id, dto.granted);
  }
}
