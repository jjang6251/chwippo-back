import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
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

  // PR_B2 Phase 1 — admin grant alert (S1)
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(1_000_000)
  adminGrantPerHourAlert?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(1_000_000)
  adminGrantSingleAlert?: number;

  // PR_B2 Phase 2 — 신규 4 임계치
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(720) // 30일
  inquirySlaHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(10_000)
  abuserSuspectDailyCalls?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10_000)
  freeUserSignupSpikePct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(10)
  costOutlierStddev?: number;

  // AI cost guard — per-user / per-feature daily USD cost cap
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  perUserDailyCostUsd?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1000)
  perFeatureDailyCostUsd?: number;

  // G-8 런타임 이상 알람 — 둘 다 건수라 컬럼이 INTEGER 다. 소수를 허용하면
  // Postgres 가 반올림해 admin 이 입력한 값과 저장된 값이 달라진다 → IsInt.
  // 하한 1 — 0 은 "매 tick 무조건 발화" 라 알람이 아니라 소음이 된다.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  outputTruncationCount1h?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  chargedFailureCount1h?: number;

  // AI 제공사 장애 알림 — 10분 error 임계(건) / 재발송 쿨다운(분)
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(1000)
  aiOutageAlertCount10m?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(1440)
  aiOutageAlertCooldownMin?: number;
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
