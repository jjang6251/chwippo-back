import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AbuserBanService } from './abuser-ban.service';
import { QuotaNotifyService } from './quota-notify.service';
import { UserAiQuota } from './entities/user-ai-quota.entity';

/**
 * cost hardening B-4 — admin 이 특정 유저의 AI 일 한도를 수동 설정.
 * - fair_use 상향 (베타 테스터·이벤트) / manual_admin 하향 (CS·제재)
 * - 소비처: UserDetailPage "AI 개별 한도" 카드
 */
class SetUserQuotaOverrideDto {
  @IsInt()
  @Min(0)
  @Max(1000)
  dailyCapOverride: number;

  /** NULL = 수동 해제까지 영구 */
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  validUntil?: Date | null;

  @IsIn(['manual_admin', 'fair_use'])
  reason: 'manual_admin' | 'fair_use';
}

interface AuthUser {
  id: string;
}

@Controller('admin/users/:userId/ai-quota-override')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminUserQuotaOverrideController {
  constructor(
    private readonly abuserBan: AbuserBanService,
    private readonly quotaNotify: QuotaNotifyService,
  ) {}

  @Get()
  async get(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<{ override: UserAiQuota | null; active: boolean }> {
    const row = await this.abuserBan.getOverrideRaw(userId);
    const active =
      !!row && (row.validUntil === null || row.validUntil > new Date());
    return { override: row, active };
  }

  @Put()
  async set(
    @CurrentUser() admin: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetUserQuotaOverrideDto,
  ): Promise<UserAiQuota> {
    const result = await this.abuserBan.setManualOverride(admin.id, userId, {
      dailyCapOverride: dto.dailyCapOverride,
      validUntil: dto.validUntil ?? null,
      reason: dto.reason,
    });
    // cost hardening ④ — 해당 유저 통지 (인앱+push+접속 시 모달, best-effort)
    await this.quotaNotify.notifyOverrideSet(userId, {
      dailyCapOverride: dto.dailyCapOverride,
      validUntil: dto.validUntil ?? null,
      reason: dto.reason,
    });
    return result;
  }

  @Delete()
  async clear(
    @CurrentUser() admin: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<{ cleared: boolean }> {
    const result = await this.abuserBan.clearOverride(admin.id, userId);
    if (result.cleared) {
      await this.quotaNotify.notifyOverrideCleared(userId);
    }
    return result;
  }
}
