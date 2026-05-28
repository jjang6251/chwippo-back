import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminAiUsageService } from './admin-ai-usage.service';

@Controller('admin/ai-usage')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminAiUsageController {
  constructor(private readonly service: AdminAiUsageService) {}

  @Get()
  overview(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('feature') feature?: string,
  ) {
    return this.service.overview({ startDate, endDate, feature });
  }

  @Get('users')
  byUser(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('feature') feature?: string,
  ) {
    return this.service.byUser({ startDate, endDate, feature });
  }

  @Get('users/:userId')
  userDetail(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.service.userDetail(userId, { startDate, endDate });
  }

  // ── F6 PR 2 Phase 5.3 — v2 메트릭 ──

  @Get('v2/by-model')
  byModel(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('feature') feature?: string,
  ) {
    return this.service.byModel({ startDate, endDate, feature });
  }

  @Get('v2/by-hour')
  byHour(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('feature') feature?: string,
  ) {
    return this.service.byHour({ startDate, endDate, feature });
  }

  @Get('v2/hallucination')
  hallucination(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.service.hallucinationStats({ startDate, endDate });
  }

  @Get('v2/cache-hit')
  cacheHit() {
    return this.service.cacheHitRate();
  }

  @Get('v2/month-estimate')
  monthEstimate() {
    return this.service.monthEstimate();
  }
}
