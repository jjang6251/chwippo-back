import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AlertThresholdsService } from './alert-thresholds.service';
import { ThresholdCheckService } from './threshold-check.service';

class UpdateAlertThresholdsDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10_000)
  dailyCostThresholdUsd?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  hourlyErrorRateThreshold?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10_000)
  vsYesterdayIncreaseThreshold?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

@Controller('admin/alert-thresholds')
@UseGuards(RolesGuard)
@Roles('admin')
export class AlertThresholdsController {
  constructor(
    private readonly service: AlertThresholdsService,
    private readonly checker: ThresholdCheckService,
  ) {}

  /** 현재 임계치 + 최근 24h alert history */
  @Get()
  async get() {
    const [thresholds, history] = await Promise.all([
      this.service.get(),
      this.service.recentHistory(),
    ]);
    return { thresholds, history };
  }

  @Patch()
  update(
    @CurrentUser() admin: { id: string },
    @Body() dto: UpdateAlertThresholdsDto,
  ) {
    return this.service.update(admin.id, dto);
  }

  /** 테스트 알람 강제 발송 — Discord 통합 확인용 */
  @Post('test')
  async test() {
    const status = await this.checker.fireAlert(
      'test',
      0,
      0,
      `🧪 임계치 알람 테스트 — Discord 연결 OK\nat ${new Date().toISOString()}`,
    );
    return { status };
  }
}
