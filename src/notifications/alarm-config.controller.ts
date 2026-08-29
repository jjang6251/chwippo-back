import { Body, Controller, Get, HttpCode, Patch } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AlarmConfigService, type AlarmStatus } from './alarm-config.service';
import { UpdateAlarmConfigDto } from './dto/update-alarm-config.dto';
import { AlarmPromptDto } from './dto/alarm-prompt.dto';
import type { AlarmConfig } from './notification.types';

interface AuthUser {
  id: string;
}

/**
 * 알림 설정.
 *   GET   /me/alarm-config     설정 조회 (NULL → 기본값 merge)
 *   GET   /me/alarm-status     「폰 알림이 갈 수 있나」 파생 판정 (기기·권한·임박 토글)
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

  /**
   * 공고 결과 시트가 「캘린더에 일정을 넣었어요」 아래에 붙일 한 줄을 정하는 근거.
   * 기기 없음 → 「앱에서 알림을 켜면 폰으로도 알려드려요」 · 꺼짐 → 「설정 › 알림에서 켜기」.
   */
  @Get('alarm-status')
  async status(@CurrentUser() user: AuthUser): Promise<AlarmStatus> {
    return this.service.getStatus(user.id);
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
